import {
  array,
  decodeJson,
  defineApp,
  defineProvider,
  json,
  number,
  object,
  plain,
  ProviderError,
  query,
  record,
  router,
  secrets,
  string,
  type QueryContext,
  type Schema,
} from "apps";

const syncro = defineProvider({
  name: "Syncro REST",
  auth: {
    apiKey: secrets({
      label: "API key and subdomain",
      fields: object({ apiKey: string(), subdomain: plain(string()) }),
    }),
  },
});
const requirements = { accounts: { syncro } };
type Context = QueryContext<typeof requirements>;
const Entity = record(json());
const Meta = object({ page: number(), total_pages: number(), per_page: number().optional() });
const Tickets = object({ tickets: array(Entity), meta: Meta });
const Customers = object({ customers: array(Entity), meta: Meta });
const Comments = object({ comments: array(Entity), meta: Meta });

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

async function get<T>(
  ctx: Context,
  path: string,
  params: Record<string, string | number | undefined>,
  schema: Schema<T>,
): Promise<T> {
  const account = ctx.accounts.syncro;
  const subdomain = account.fields.subdomain;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain))
    throw new Error(
      "Syncro subdomain must be a lowercase DNS label, without a URL or domain suffix",
    );
  const url = new URL(`https://${subdomain}.syncromsp.com/api/v1${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await ctx.fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: { Authorization: `Bearer ${account.fields.apiKey}`, Accept: "application/json" },
  });
  if (!response.ok) {
    // Never surface an upstream response body, which may echo credentials.
    throw new ProviderError({
      reason:
        response.status === 401
          ? "unauthorized"
          : response.status === 429
            ? "rate_limited"
            : response.status >= 500
              ? "unavailable"
              : "rejected",
      status: response.status,
      accountId: account.id,
    });
  }
  return decodeJson(response, schema);
}

function pagination(meta: { page: number; total_pages: number }, requested: number) {
  positive(meta.page, "Response page");
  if (!Number.isSafeInteger(meta.total_pages) || meta.total_pages < 0 || meta.page !== requested)
    throw new Error("Syncro returned invalid pagination");
  return { nextPage: meta.page < meta.total_pages ? meta.page + 1 : null };
}

export default defineApp(requirements, {
  tools: router({
    getTicket: query(
      {
        description: "Get a Syncro ticket by ID. Read comments with ticketComments.",
        input: object({ id: number() }),
      },
      (ctx, { id }) =>
        get(ctx, `/tickets/${positive(id, "Ticket ID")}`, {}, object({ ticket: Entity })),
    ),
    searchTickets: query(
      {
        description:
          "Read one page of Syncro tickets. Follow nextPage until null for complete results; comments are read separately.",
        input: object({
          page: number().default(1),
          query: string().optional(),
          status: string().optional(),
          customerId: number().optional(),
          sinceUpdatedAt: string().optional(),
          ticketSearchId: number().optional(),
        }),
      },
      async (ctx, input) => {
        const page = positive(input.page, "Page");
        const result = await get(
          ctx,
          "/tickets",
          {
            page,
            query: input.query,
            status: input.status,
            customer_id:
              input.customerId === undefined
                ? undefined
                : positive(input.customerId, "Customer ID"),
            since_updated_at: input.sinceUpdatedAt,
            ticket_search_id:
              input.ticketSearchId === undefined
                ? undefined
                : positive(input.ticketSearchId, "Ticket search ID"),
          },
          Tickets,
        );
        return { ...result, ...pagination(result.meta, page) };
      },
    ),
    getCustomer: query(
      { description: "Get a Syncro customer by ID.", input: object({ id: number() }) },
      (ctx, { id }) =>
        get(ctx, `/customers/${positive(id, "Customer ID")}`, {}, object({ customer: Entity })),
    ),
    searchCustomers: query(
      {
        description:
          "Read one page of Syncro customers. Follow nextPage until null for complete results.",
        input: object({
          page: number().default(1),
          query: string().optional(),
          email: string().optional(),
        }),
      },
      async (ctx, input) => {
        const page = positive(input.page, "Page");
        const result = await get(
          ctx,
          "/customers",
          { page, query: input.query, email: input.email },
          Customers,
        );
        return { ...result, ...pagination(result.meta, page) };
      },
    ),
    ticketComments: query(
      {
        description:
          "Read one page of a ticket's comments, including internal comments available to this account. Follow nextPage until null.",
        input: object({
          id: number(),
          page: number().default(1),
          perPage: number().default(10),
          createdAfter: string().optional(),
          updatedAfter: string().optional(),
        }),
      },
      async (ctx, input) => {
        const page = positive(input.page, "Page");
        const perPage = positive(input.perPage, "Comments per page");
        if (perPage > 100) throw new Error("Comments per page must be at most 100");
        const result = await get(
          ctx,
          `/tickets/${positive(input.id, "Ticket ID")}/comments`,
          {
            page,
            per_page: perPage,
            created_after: input.createdAfter,
            updated_after: input.updatedAfter,
            comment_format: "plaintext",
          },
          Comments,
        );
        return { ...result, ...pagination(result.meta, page) };
      },
    ),
  }),
});
