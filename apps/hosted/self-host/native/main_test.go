package main

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeWorkerd serves HTTP/1.1 on a Unix socket with kj's keep-alive rule: once a
// response completes, the connection closes if no request starts within the
// idle timeout. A request arriving at that moment is dropped unread, which is
// the race a pooled proxy connection can lose.
type fakeWorkerd struct {
	idleTimeout time.Duration
	// dropFirst closes a fresh connection after reading its request, without a response.
	dropFirst bool
	received  atomic.Int32
	handled   atomic.Int32
	// proto records the X-Forwarded-Proto header of the last request read.
	proto atomic.Value
}

func (f *fakeWorkerd) serve(t *testing.T, socket string) {
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go f.connection(conn)
		}
	}()
}

func (f *fakeWorkerd) connection(conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	for first := true; ; first = false {
		idleSince := time.Now()
		if _, err := reader.Peek(1); err != nil {
			return
		}
		if !first && time.Since(idleSince) >= f.idleTimeout {
			return
		}
		request, err := http.ReadRequest(reader)
		if err != nil {
			return
		}
		if _, err = io.Copy(io.Discard, request.Body); err != nil {
			return
		}
		f.received.Add(1)
		f.proto.Store(request.Header.Get("X-Forwarded-Proto"))
		if f.dropFirst && first {
			return
		}
		f.handled.Add(1)
		if _, err = io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"); err != nil {
			return
		}
	}
}

func socketPath(t *testing.T) string {
	// Unix socket paths are limited to about 100 bytes, which t.TempDir can exceed on macOS.
	directory, err := os.MkdirTemp("", "proxy-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	return filepath.Join(directory, "product.sock")
}

func post(t *testing.T, address string) (int, string) {
	t.Helper()
	response, err := http.Post(address+"/api/workflow-runs", "application/json", strings.NewReader(`{"key":"k"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, strings.TrimSpace(string(body))
}

func TestProxyDoesNotReuseConnectionsWorkerdHasTimedOut(t *testing.T) {
	socket := socketPath(t)
	upstream := &fakeWorkerd{idleTimeout: 300 * time.Millisecond}
	upstream.serve(t, socket)
	front := httptest.NewServer(productProxy(socket, upstream.idleTimeout, nil))
	defer front.Close()

	if status, body := post(t, front.URL); status != 200 {
		t.Fatalf("first POST: %d %s", status, body)
	}
	time.Sleep(upstream.idleTimeout + 100*time.Millisecond)
	if status, body := post(t, front.URL); status != 200 {
		t.Fatalf("POST after workerd's idle timeout: %d %s", status, body)
	}
	if handled := upstream.handled.Load(); handled != 2 {
		t.Fatalf("workerd handled %d POSTs, want 2", handled)
	}
}

func TestProxyDoesNotRetryPostWorkerdMayHaveReceived(t *testing.T) {
	socket := socketPath(t)
	upstream := &fakeWorkerd{idleTimeout: time.Minute, dropFirst: true}
	upstream.serve(t, socket)
	front := httptest.NewServer(productProxy(socket, upstream.idleTimeout, nil))
	defer front.Close()

	status, body := post(t, front.URL)
	if status != http.StatusBadGateway || body == "Executor is starting" {
		t.Fatalf("dropped POST: %d %q, want 502 with the upstream failure", status, body)
	}
	if received := upstream.received.Load(); received != 1 {
		t.Fatalf("workerd received the POST %d times, want 1", received)
	}
}

func TestProxyReportsStartingUntilWorkerdListens(t *testing.T) {
	front := httptest.NewServer(productProxy(socketPath(t), workerdIdleTimeout, nil))
	defer front.Close()

	if status, body := post(t, front.URL); status != http.StatusServiceUnavailable || body != "Executor is starting" {
		t.Fatalf("POST before workerd listens: %d %q", status, body)
	}
}

func TestProxyForwardsTheSchemeTheBrowserUsed(t *testing.T) {
	socket := socketPath(t)
	upstream := &fakeWorkerd{idleTimeout: time.Minute}
	upstream.serve(t, socket)
	// The public listener's own handler stack, compression and full duplex included.
	front := httptest.NewServer(publicHandler(productProxy(socket, upstream.idleTimeout, nil)))
	defer front.Close()

	send := func(proto string) string {
		t.Helper()
		request, err := http.NewRequest(http.MethodGet, front.URL+"/api/dashboard/batch", nil)
		if err != nil {
			t.Fatal(err)
		}
		if proto != "" {
			request.Header.Set("X-Forwarded-Proto", proto)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatalf("status %d, want 200", response.StatusCode)
		}
		seen, _ := upstream.proto.Load().(string)
		return seen
	}
	// An HTTPS reverse proxy in front reports the browser's scheme; the product must see it.
	if seen := send("https"); seen != "https" {
		t.Fatalf("X-Forwarded-Proto behind an HTTPS proxy: %q, want https", seen)
	}
	if seen := send("https, http"); seen != "https" {
		t.Fatalf("X-Forwarded-Proto through a proxy chain: %q, want https", seen)
	}
	// Without a proxy, the scheme is the one this plain listener accepted.
	if seen := send(""); seen != "http" {
		t.Fatalf("X-Forwarded-Proto on a direct connection: %q, want http", seen)
	}
	// A value that is not a scheme does not reach the product.
	if seen := send("javascript:"); seen != "http" {
		t.Fatalf("X-Forwarded-Proto with an invalid value: %q, want http", seen)
	}
}

// The collector runs beside the product: an exit is followed by a restart, not by the product
// stopping. The waits double from the minimum to the maximum, so a collector that cannot start
// does not spin, and return to the minimum after a run longer than the maximum.
func TestSuperviseRestartsAnExitedProcessWithBackoff(t *testing.T) {
	var mutex sync.Mutex
	var waits []time.Duration
	after := func(delay time.Duration) <-chan time.Time {
		mutex.Lock()
		waits = append(waits, delay)
		mutex.Unlock()
		return time.After(0)
	}
	var starts atomic.Int32
	stop := supervise(func() *exec.Cmd {
		// The fifth process outlives the maximum wait; every other one exits at once.
		if starts.Add(1) == 5 {
			return exec.Command("sh", "-c", "sleep 0.6; exit 1")
		}
		return exec.Command("sh", "-c", "exit 1")
	}, 100*time.Millisecond, 400*time.Millisecond, after)
	deadline := time.Now().Add(10 * time.Second)
	for starts.Load() < 7 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	stop()
	mutex.Lock()
	recorded := append([]time.Duration(nil), waits...)
	mutex.Unlock()
	want := []time.Duration{100, 200, 400, 400, 100, 200}
	if len(recorded) < len(want) {
		t.Fatalf("waited %v, want at least %v ms", recorded, want)
	}
	for index, milliseconds := range want {
		if recorded[index] != milliseconds*time.Millisecond {
			t.Fatalf("waited %v, want %v ms first", recorded, want)
		}
	}
	settled := starts.Load()
	time.Sleep(100 * time.Millisecond)
	if count := starts.Load(); count != settled {
		t.Fatalf("started %d times after stop, want %d", count, settled)
	}
}

func TestSuperviseStopsARunningProcess(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "stopped")
	stop := supervise(func() *exec.Cmd {
		return exec.Command("sh", "-c", `trap 'touch "$0"; exit 0' TERM; while :; do sleep 0.05; done`, marker)
	}, time.Second, time.Second, time.After)
	time.Sleep(200 * time.Millisecond)
	returned := make(chan struct{})
	go func() { stop(); close(returned) }()
	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("stop did not return after SIGTERM")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("the process was not sent SIGTERM: %v", err)
	}
}

func TestMemoryPressureIsSixtyPercentOfTheCgroupLimit(t *testing.T) {
	directory := t.TempDir()
	write := func(name, content string) string {
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	cases := []struct {
		name string
		file string
		want uint64
	}{
		{"4 GiB limit", write("limited", "4294967296\n"), 2457},
		{"no limit", write("unlimited", "max\n"), 0},
		{"no cgroup v2", filepath.Join(directory, "missing"), 0},
	}
	for _, c := range cases {
		if got := memoryPressureMiB(c.file); got != c.want {
			t.Errorf("%s: memoryPressureMiB = %d, want %d", c.name, got, c.want)
		}
	}
}

// immediate fires every watchdog wait at once, so a sequence of probe results drives it.
func immediate(time.Duration) <-chan time.Time {
	tick := make(chan time.Time, 1)
	tick <- time.Time{}
	return tick
}

func runWatchdog(results []bool, failures int) (stalled bool, probes int) {
	done := make(chan struct{})
	var stop sync.Once
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		watchdog(func() bool {
			if probes >= len(results) {
				// Past the script: stop as if the host were shutting down.
				stop.Do(func() { close(done) })
				return true
			}
			result := results[probes]
			probes++
			return result
		}, time.Second, failures, immediate, done, func() { stalled = true })
	}()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		panic("watchdog did not return")
	}
	stop.Do(func() { close(done) })
	return stalled, probes
}

func TestWatchdogWaitsForTheFirstAnswerBeforeCounting(t *testing.T) {
	stalled, _ := runWatchdog([]bool{false, false, false, false, false}, 3)
	if stalled {
		t.Fatal("a product that never answered yet (startup, migrations) must not be killed")
	}
}

func TestWatchdogKillsAfterConsecutiveFailures(t *testing.T) {
	stalled, probes := runWatchdog([]bool{true, false, false, false, true}, 3)
	if !stalled || probes != 4 {
		t.Fatalf("expected a stall on the third failure in a row, got stalled=%v after %d probes", stalled, probes)
	}
}

func TestWatchdogResetsOnAnAnswer(t *testing.T) {
	stalled, _ := runWatchdog([]bool{true, false, false, true, false, false, true}, 3)
	if stalled {
		t.Fatal("failures separated by an answer must not add up")
	}
}

func TestWatchdogStopsWhenTheHostStops(t *testing.T) {
	done := make(chan struct{})
	close(done)
	stalled := false
	watchdog(func() bool { return false }, time.Second, 1, func(time.Duration) <-chan time.Time { return make(chan time.Time) }, done, func() { stalled = true })
	if stalled {
		t.Fatal("a stopping host must not report a stall")
	}
}

func TestProductProbeReportsOnlyOK(t *testing.T) {
	// Unix socket paths are short on macOS; t.TempDir() can exceed the limit.
	dir, err := os.MkdirTemp("/tmp", "wd")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	socket := filepath.Join(dir, "product.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	status := http.StatusOK
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(status)
	})}
	go server.Serve(listener)
	defer server.Close()
	probe := productProbe(socket, time.Second)
	if !probe() {
		t.Fatal("a 200 from /health is an answer")
	}
	status = http.StatusServiceUnavailable
	if probe() {
		t.Fatal("a non-200 is not an answer")
	}
	server.Close()
	if probe() {
		t.Fatal("a closed socket is not an answer")
	}
}

func TestSuperviseProcessKillRestartsOnlyThatProcess(t *testing.T) {
	var starts atomic.Int32
	stop, kill := superviseProcess("Test process", func() *exec.Cmd {
		starts.Add(1)
		// A process that never exits on its own, like a workerd whose thread is stuck.
		return exec.Command("sh", "-c", "while :; do sleep 0.05; done")
	}, 10*time.Millisecond, 50*time.Millisecond, func(time.Duration) <-chan time.Time { return time.After(0) })
	defer stop()
	waitFor := func(count int32) {
		deadline := time.Now().Add(5 * time.Second)
		for starts.Load() < count && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if starts.Load() < count {
			t.Fatalf("started %d times, want %d", starts.Load(), count)
		}
	}
	waitFor(1)
	// Let the first process be registered as running before killing it.
	time.Sleep(100 * time.Millisecond)
	kill()
	waitFor(2)
	time.Sleep(100 * time.Millisecond)
	if count := starts.Load(); count != 2 {
		t.Fatalf("a running process restarted on its own: %d starts", count)
	}
}
