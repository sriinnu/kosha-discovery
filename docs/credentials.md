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
    "fast": "claude-haiku-4-5-20251001"
  },
  "cacheTtlMs": 3600000
}
```

Config priority: `~/.kosharc.json` < `kosha.config.json` < programmatic config.
