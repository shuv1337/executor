# Serves the bundled Motel collector. Hosts supply the motel-data and motel-assets
# directories with --directory-path and the motel socket address with --socket-addr.
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services=[
  (name="motel",worker=(
   compatibilityDate="2026-09-01",modules=[(name="motel.mjs",esModule=embed "motel.mjs")],
   bindings=[(name="STORE",durableObjectNamespace="MotelCollector"),(name="ASSETS",service="motel-assets"),(name="MOTEL_OTEL_RETENTION_HOURS",text="168"),(name="MOTEL_OTEL_MAX_DB_SIZE_MB",text="1024")],
   durableObjectNamespaces=[(className="MotelCollector",uniqueKey="motel",enableSql=true)],durableObjectStorage=(localDisk="motel-data")
  )),
  (name="motel-assets",disk=(path="web/dist")),
  (name="motel-data",disk=(path="data",writable=true,allowDotfiles=true))
 ],
 sockets=[(name="motel",address="127.0.0.1:0",http=(),service="motel")]
);
