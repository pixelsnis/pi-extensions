import type {
  Api,
  ApiStreamOptions,
  Context,
  Credential,
  DeferredHandle,
  Model,
  Provider,
  RefreshModelsContext,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type OpenAIProviderId = "openai" | "openai-codex";
type PayloadCallback = (
  payload: unknown,
  model: Model<Api>,
) => unknown | undefined | Promise<unknown | undefined>;

const PROVIDER_IDS: readonly OpenAIProviderId[] = ["openai", "openai-codex"];
const FAST_SUFFIX = "-fast";

function createFastAliases(
  models: readonly Model<Api>[],
  providerId: OpenAIProviderId,
  existingIds: Set<string>,
): { aliases: Model<Api>[]; aliasBases: Map<string, string> } {
  const aliases: Model<Api>[] = [];
  const aliasBases = new Map<string, string>();

  for (const model of models) {
    if (model.provider !== providerId || !model.id || model.id.endsWith(FAST_SUFFIX)) {
      continue;
    }

    const aliasId = `${model.id}${FAST_SUFFIX}`;
    if (existingIds.has(aliasId)) continue;

    existingIds.add(aliasId);
    aliasBases.set(aliasId, model.id);
    aliases.push({
      ...model,
      id: aliasId,
      name: `${model.name} (fast)`,
    });
  }

  return { aliases, aliasBases };
}

function withFastPayload<TOptions extends object>(options: TOptions | undefined, baseId: string): TOptions {
  const previous = (options as { onPayload?: PayloadCallback } | undefined)?.onPayload;

  return {
    ...options,
    onPayload: async (payload: unknown, model: Model<Api>) => {
      const transformed = await previous?.(payload, model);
      const currentPayload = transformed === undefined ? payload : transformed;

      if (typeof currentPayload !== "object" || currentPayload === null || Array.isArray(currentPayload)) {
        throw new Error("Fast model alias expected the provider to build an object request payload");
      }

      return {
        ...(currentPayload as Record<string, unknown>),
        model: baseId,
        service_tier: "priority",
      };
    },
  } as TOptions;
}

function wrapProvider(provider: Provider, providerId: OpenAIProviderId): Provider {
  let aliasBases = new Map<string, string>();

  function getBaseModel(model: Model<Api>): Model<Api> {
    const baseId = aliasBases.get(model.id);
    return baseId ? { ...model, id: baseId } : model;
  }

  function forwardOptions<TOptions extends object>(options: TOptions | undefined, model: Model<Api>): TOptions | undefined {
    const baseId = aliasBases.get(model.id);
    return baseId ? withFastPayload(options, baseId) : options;
  }

  return {
    id: providerId,
    get name() {
      return provider.name;
    },
    get baseUrl() {
      return provider.baseUrl;
    },
    get headers() {
      return provider.headers;
    },
    get auth() {
      return provider.auth;
    },
    getModels() {
      const models = provider.getModels();
      const existingIds = new Set(models.map((model) => model.id));
      const result = createFastAliases(models, providerId, existingIds);
      aliasBases = result.aliasBases;
      return [...models, ...result.aliases];
    },
    filterModels(models, credential: Credential | undefined) {
      const originals = models.filter((model) => !aliasBases.has(model.id));
      const filteredOriginals = provider.filterModels?.(originals, credential) ?? originals;
      const existingIds = new Set(originals.map((model) => model.id));
      const result = createFastAliases(filteredOriginals, providerId, existingIds);
      aliasBases = result.aliasBases;
      return [...filteredOriginals, ...result.aliases];
    },
    ...(provider.refreshModels
      ? {
          refreshModels: (context: RefreshModelsContext) => provider.refreshModels!.call(provider, context),
        }
      : {}),
    stream<T extends Api>(model: Model<T>, context: Context, options?: ApiStreamOptions<T>) {
      const baseId = aliasBases.get(model.id);
      if (!baseId) return provider.stream(model, context, options);

      return provider.stream({ ...model, id: baseId }, context, withFastPayload(options, baseId));
    },
    streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
      const baseId = aliasBases.get(model.id);
      if (!baseId) return provider.streamSimple(model, context, options);

      return provider.streamSimple({ ...model, id: baseId }, context, withFastPayload(options, baseId));
    },
    ...(provider.fetchDeferred
      ? {
          fetchDeferred: (model: Model<Api>, handle: DeferredHandle, options?: Parameters<NonNullable<Provider["fetchDeferred"]>>[2]) =>
            provider.fetchDeferred!.call(provider, getBaseModel(model), handle, options),
        }
      : {}),
    ...(provider.cancelDeferred
      ? {
          cancelDeferred: (model: Model<Api>, handle: DeferredHandle, options?: Parameters<NonNullable<Provider["cancelDeferred"]>>[2]) =>
            provider.cancelDeferred!.call(provider, getBaseModel(model), handle, options),
        }
      : {}),
  };
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    for (const providerId of PROVIDER_IDS) {
      const provider = ctx.modelRegistry.getProvider(providerId);
      if (!provider || provider.id !== providerId) continue;
      pi.registerProvider(wrapProvider(provider, providerId));
    }
  });
}
