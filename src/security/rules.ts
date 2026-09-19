export interface SecretRule {
  id: string;
  label: string;
  re: RegExp;
  /** For generic rules: index of the capture group holding the secret value. */
  valueGroup?: number;
}

export interface Finding {
  path: string;
  /** Line number in the new file, when known. */
  line?: number;
  ruleId: string;
  label: string;
}

/** Shannon entropy in bits per character; random keys score high, words and placeholders low. */
export function entropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PLACEHOLDER = /example|your[_-]|xxxx|changeme|placeholder|dummy|sample|fake|test|<[^>]+>|\{\{|\$\{|process\.env|os\.environ|getenv/i;

export const RULES: SecretRule[] = [
  { id: "private-key", label: "Private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|(?=\n@@)|$)/g },
  { id: "aws-access-key", label: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "github-token", label: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { id: "anthropic-key", label: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai-key", label: "OpenAI-style API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { id: "google-api-key", label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "slack-token", label: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: "stripe-key", label: "Stripe live key", re: /\b[sr]k_live_[0-9a-zA-Z]{20,}/g },
  { id: "jwt", label: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: "url-credentials", label: "Password inside a URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:([^\s@/'"]{3,})@[^\s/'"]+/gi, valueGroup: 1 },
  {
    id: "generic-secret",
    label: "Hard-coded secret",
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\w*["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi,
    valueGroup: 1,
  },
];

/** True when a generic match looks like a real secret rather than a placeholder or a word. */
function plausible(rule: SecretRule, value: string): boolean {
  if (rule.id === "url-credentials") return !PLACEHOLDER.test(value) && !/^(password|pass|user|\*+)$/i.test(value);
  if (rule.id !== "generic-secret") return true;
  return !PLACEHOLDER.test(value) && entropy(value) >= 3.2;
}

/** Rules that match anywhere in one line of text. */
export function scanLine(text: string): { ruleId: string; label: string }[] {
  const hits: { ruleId: string; label: string }[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
      const value = rule.valueGroup ? (m[rule.valueGroup] ?? "") : m[0];
      if (plausible(rule, value)) {
        hits.push({ ruleId: rule.id, label: rule.label });
        break;
      }
    }
  }
  return hits;
}

/** Replaces every secret in `text` with a marker, so it can be sent to the AI safely. */
export function redact(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(new RegExp(rule.re.source, rule.re.flags), (match, ...groups) => {
      if (!rule.valueGroup) return `[REDACTED:${rule.id}]`;
      const value = groups[rule.valueGroup - 1] as string | undefined;
      if (!value || !plausible(rule, value)) return match;
      return match.replace(value, `[REDACTED:${rule.id}]`);
    });
  }
  return out;
}

const SENSITIVE_PATH_RE = [
  /(^|\/)\.env(\.(?!example|sample|template|dist)[\w.-]+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)(credentials|secrets?)(\.[\w-]+)?\.(json|ya?ml|toml|ini|txt)$/i,
  /(^|\/)\.(npmrc|pypirc|netrc|pgpass|htpasswd)$/i,
  /(^|\/)terraform\.tfvars$|\.tfstate(\.backup)?$/i,
  /(^|\/)serviceaccount[\w-]*\.json$/i,
];

/** File names that usually hold secrets; their content is never sent to the AI. */
export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_RE.some((re) => re.test(path)) && !/\.pub$/.test(path);
}
