# Provider Credentials

Kosha auto-discovers credentials from environment variables, CLI tool configs, and cloud auth files. Set up whichever providers you use.

## Anthropic

```bash
# Option A: Environment variable
export ANTHROPIC_API_KEY=sk-ant-...

# Option B: Auto-detected from Claude CLI / Claude Code
# If you've run `claude` or `claude-code`, kosha reads the stored token from:
#   ~/.claude.json
#   ~/.config/claude/settings.json
#   ~/.claude/credentials.json

# Option C: Auto-detected from Codex CLI
#   ~/.codex/auth.json
```

## OpenAI

```bash
# Option A: Environment variable
export OPENAI_API_KEY=sk-...

# Option B: Auto-detected from GitHub Copilot
# If you've authenticated with Copilot, kosha reads tokens from:
#   ~/.config/github-copilot/hosts.json (Linux/macOS)
#   %LOCALAPPDATA%/github-copilot/hosts.json (Windows)
```

## Google (Gemini)

```bash
# Option A: Environment variable
export GOOGLE_API_KEY=AIza...
# or
export GEMINI_API_KEY=AIza...

# Option B: Auto-detected from Gemini CLI
#   ~/.gemini/oauth_creds.json

# Option C: gcloud Application Default Credentials
gcloud auth application-default login
```

## AWS Bedrock

```bash
# Option A: Environment variables
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
export AWS_DEFAULT_REGION=us-east-1   # optional, defaults to us-east-1

# Option B: AWS CLI configured profile
aws configure
# kosha reads ~/.aws/credentials [default] automatically

# Option C: Named profile
export AWS_PROFILE=my-profile

# Option D: SSO / IAM role
# kosha detects sso_start_url or role_arn in ~/.aws/config

# Optional: install the AWS SDK for live model listing (otherwise uses static fallback)
npm install @aws-sdk/client-bedrock
```

## Google Vertex AI

```bash
# Option A: Service account JSON
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
export GOOGLE_CLOUD_PROJECT=my-project

# Option B: gcloud Application Default Credentials
gcloud auth application-default login
# Project auto-detected from: GOOGLE_CLOUD_PROJECT, GCLOUD_PROJECT,
# or `gcloud config get-value project`

# Option C: gcloud access token (auto-detected via subprocess)
gcloud auth print-access-token
```

## OpenRouter

```bash
# Optional — OpenRouter works without auth (rate-limited)
export OPENROUTER_API_KEY=sk-or-...
```

## Vercel AI Gateway

```bash
# Optional for model discovery; required when invoking models through the gateway
export AI_GATEWAY_API_KEY=...

# Also accepted on Vercel deployments
export VERCEL_OIDC_TOKEN=...
```

## NVIDIA (build.nvidia.com)

```bash
export NVIDIA_API_KEY=nvapi-...
```

## Together AI

```bash
export TOGETHER_API_KEY=...
```

## Fireworks AI

```bash
export FIREWORKS_API_KEY=...
```

## Groq

```bash
export GROQ_API_KEY=gsk_...
```

## Mistral AI

```bash
export MISTRAL_API_KEY=...
```

## DeepInfra

```bash
export DEEPINFRA_API_KEY=...
```

## Cohere

```bash
export CO_API_KEY=...
```

## Cerebras

```bash
export CEREBRAS_API_KEY=...
```

## Perplexity

```bash
export PERPLEXITY_API_KEY=pplx-...
```

## DeepSeek

```bash
export DEEPSEEK_API_KEY=...
```

## Moonshot (Kimi)

```bash
# Either variable is accepted
export MOONSHOT_API_KEY=...
# or
export KIMI_API_KEY=...
```

## GLM (Zhipu)

```bash
# Either variable is accepted
export GLM_API_KEY=...
# or
export ZHIPUAI_API_KEY=...
```

## Z.AI

```bash
export ZAI_API_KEY=...
```

## MiniMax

```bash
export MINIMAX_API_KEY=...
```

## GitHub Actions smoke checks

If you enable `.github/workflows/provider-smoke.yml`, set only the secrets for providers you want to exercise. Providers without matching secrets are skipped, and the workflow always uploads a JSON report artifact without printing secret values.

- Bedrock: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`
- Vertex AI: `GOOGLE_APPLICATION_CREDENTIALS_JSON`, `GOOGLE_CLOUD_PROJECT`

## Ollama (Local)

```bash
# No credentials needed — auto-detected if running locally
# Default: http://localhost:11434
ollama serve
```

## Config File (optional)

Instead of env vars, you can create `~/.kosharc.json` (global) or `kosha.config.json` (project-level):

```json
{
  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." },
    "openai": { "apiKey": "sk-..." },
    "bedrock": { "enabled": true },
    "vertex": { "enabled": true },
    "openrouter": { "enabled": false }
  },
  "aliases": {
    "fast": "claude-haiku-4-5"
  },
  "cacheTtlMs": 3600000
}
```

Config priority: `~/.kosharc.json` < `kosha.config.json` < programmatic config.

## New providers (Unreleased)

| Provider | Env vars (first match wins) | Notes |
|---|---|---|
| `xai` | `XAI_API_KEY`, `GROK_API_KEY` | Direct Grok access at `api.x.ai/v1`. |
| `typesafe` | `TYPESAFE_API_KEY`, `JEV_API_KEY` | The SDK reads `TYPESAFE_API_KEY`; the key is often stored under the model's name, so both work. |
| `thinkingmachines` | `TINKER_API_KEY`, `THINKINGMACHINES_API_KEY` | Discovery is catalog-only — Tinker publishes no model-list endpoint. |
| `alibaba` | `DASHSCOPE_API_KEY`, `ALIBABA_API_KEY`, `QWEN_API_KEY` | International host (`dashscope-intl`). |
| `alibaba-cn` | `DASHSCOPE_CN_API_KEY`, `DASHSCOPE_API_KEY` | China host. Prices differ from the international region. |
| `moonshot` | `MOONSHOT_API_KEY`, `KIMI_API_KEY` | International host (`api.moonshot.ai`). |
| `moonshot-cn` | `MOONSHOT_CN_API_KEY`, `MOONSHOT_API_KEY`, `KIMI_API_KEY` | China host (`api.moonshot.cn`). |
| `minimax` / `minimax-cn` | `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY`, `MINIMAX_API_KEY` | `api.minimax.io` / `api.minimaxi.com`. |
| `siliconflow` / `siliconflow-cn` | `SILICONFLOW_API_KEY` / `SILICONFLOW_CN_API_KEY`, `SILICONFLOW_API_KEY` | `.com` / `.cn`. |
| `stepfun` / `stepfun-cn` | `STEPFUN_API_KEY` / `STEPFUN_CN_API_KEY`, `STEPFUN_API_KEY` | `api.stepfun.ai` / `api.stepfun.com`. |
| `volcengine` | `ARK_API_KEY`, `VOLCENGINE_API_KEY` | Doubao via Ark; China region only. |
| `inception` | `INCEPTION_API_KEY` | Mercury diffusion LLMs. |
| `ai21` | `AI21_API_KEY` | Jamba. |
| `upstage` | `UPSTAGE_API_KEY` | Solar. |
| `baseten` | `BASETEN_API_KEY` | |
| `nebius` | `NEBIUS_API_KEY` | Token Factory. |
| `novita` | `NOVITA_API_KEY` | |
| `huggingface` | `HF_TOKEN`, `HUGGINGFACE_API_KEY`, `HUGGING_FACE_HUB_TOKEN` | Router; the serving provider varies per model. |
| `ollama-cloud` | `OLLAMA_API_KEY` | Distinct from the local `ollama` runtime, which needs no key. |
| `glm` | `GLM_API_KEY`, `ZHIPUAI_API_KEY`, `ZHIPU_API_KEY` | `ZHIPU_API_KEY` added — it is the name models.dev documents. |

A provider whose credential is a plain API key in an env var needs no code: the
resolver reads `credentialEnvVars` from the provider descriptor in
`src/provider-catalog.ts` by default. Only a bespoke search order (CLI config
files, OAuth, ADC, AWS SSO) needs a branch in `src/credentials/resolver.ts`.

### Regions take separate keys

A China-region provider is a separate account with its own key and its own
prices. Where kosha accepts the international variable as a fallback
(`MOONSHOT_API_KEY` for `moonshot-cn`, say), that is a convenience for people who
only hold one — it will fail authentication if the key is not valid for that
host. Prefer the explicit `*_CN_API_KEY` form when you hold both.
