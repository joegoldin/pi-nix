{ piSource }:
let
  sourceAuthority = relativePath: {
    path = "${piSource}/${relativePath}";
    inherit relativePath;
  };
  standardCompute = {
    name = "Standard Compute";
    baseUrl = "https://api.stdcmpt.com/v1";
    api = "openai-responses";
    models = [
      {
        id = "standardcompute";
        name = "Standard Compute";
        reasoning = false;
        input = [
          "text"
          "image"
        ];
        cost = {
          input = 0;
          output = 0;
          cacheRead = 0;
          cacheWrite = 0;
        };
        contextWindow = 200000;
        maxTokens = 8192;
      }
    ];
  };
in
{
  version = 1;

  providers = {
    openai-codex = {
      kind = "pi-builtin";
      sourceAuthorities = {
        api = sourceAuthority "packages/ai/src/api/openai-codex-responses.ts";
        auth = sourceAuthority "packages/ai/src/auth/oauth/openai-codex.ts";
        catalog = sourceAuthority "packages/ai/src/providers/openai-codex.models.ts";
        provider = sourceAuthority "packages/ai/src/providers/openai-codex.ts";
      };
    };

    openrouter.kind = "pi-builtin";

    standardcompute = {
      kind = "custom";
      publicModelSchema = standardCompute;
    };
  };

  models.providers.standardcompute = standardCompute;
}
