/** Auth headers for the embedding and rerank servers. Secrets stay in headers, never in errors. */

export type ModelEndpoint = "embedding" | "rerank";

export interface ModelAuthSettings {
  embeddingApiKey: string;
  embeddingApiKeyHeader: string;
  rerankApiKey: string;
  rerankApiKeyHeader: string;
}

export interface ModelHttpRequestInit {
  url: string;
  method: "POST";
  contentType: "application/json";
  headers?: Record<string, string>;
  body: string;
  throw: false;
}

export interface ModelHttpResponse {
  status: number;
  text: string;
}

export type ModelHttpRequest = (init: ModelHttpRequestInit) => Promise<ModelHttpResponse>;

const HEADER_NAME = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;

export function rejectedApiKeyMessage(endpoint: ModelEndpoint): string {
  return `The ${endpoint} server rejected the API key`;
}

/** Rerank key and header fall back to the embedding values when blank. */
export function resolveModelAuth(
  settings: ModelAuthSettings,
  endpoint: ModelEndpoint
): { apiKey: string; headerName: string } {
  const embeddingKey = settings.embeddingApiKey ?? "";
  const embeddingHeader = settings.embeddingApiKeyHeader ?? "";
  if (endpoint === "embedding") {
    return { apiKey: embeddingKey, headerName: embeddingHeader };
  }
  const rerankKey = (settings.rerankApiKey ?? "").trim();
  const rerankHeader = (settings.rerankApiKeyHeader ?? "").trim();
  return {
    apiKey: rerankKey ? settings.rerankApiKey : embeddingKey,
    headerName: rerankHeader ? settings.rerankApiKeyHeader : embeddingHeader
  };
}

/**
 * Empty key sends no header. An empty header name, or Authorization, sends
 * `Authorization: Bearer <key>`. Any other header name sends the raw key.
 */
export function modelAuthHeaders(endpoint: ModelEndpoint, apiKey: string, headerName: string): Record<string, string> {
  const key = apiKey.trim();
  if (!key) return {};
  if (/[\u0000-\u001F\u007F]/.test(key)) {
    throw new Error(`The ${endpoint} API key contains a control character and was not sent`);
  }
  const name = headerName.trim();
  if (!name || name.toLowerCase() === "authorization") {
    return { Authorization: `Bearer ${key}` };
  }
  if (!HEADER_NAME.test(name)) {
    throw new Error(`The ${endpoint} API key header name is not a valid HTTP header name`);
  }
  return { [name]: key };
}

export function redactSecret(text: string, secret: string): string {
  const key = secret.trim();
  if (!key) return text;
  return text.split(key).join("[redacted]");
}

function transportFailureMessage(endpoint: ModelEndpoint, error: unknown, secret: string): string {
  const raw = error instanceof Error ? error.message : "";
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const redacted = redactSecret(collapsed, secret);
  if (!redacted || redacted !== collapsed || /authorization|bearer|api[-_ ]?key/i.test(redacted)) {
    return `The ${endpoint} server request failed`;
  }
  return `The ${endpoint} server request failed: ${redacted.slice(0, 200)}`;
}

function httpFailureMessage(endpoint: ModelEndpoint, status: number, body: string, secret: string): string {
  const detail = redactSecret(body, secret).replace(/\s+/g, " ").trim().slice(0, 180);
  return `The ${endpoint} server returned HTTP ${status}${detail ? `: ${detail}` : ""}`;
}

export async function postModelJson(
  request: ModelHttpRequest,
  options: {
    url: string;
    endpoint: ModelEndpoint;
    apiKey: string;
    headerName: string;
    body: unknown;
  }
): Promise<unknown> {
  const headers = modelAuthHeaders(options.endpoint, options.apiKey, options.headerName);
  const secret = options.apiKey.trim();
  let response: ModelHttpResponse;
  try {
    response = await request({
      url: options.url,
      method: "POST",
      contentType: "application/json",
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: JSON.stringify(options.body),
      throw: false
    });
  } catch (error) {
    throw new Error(transportFailureMessage(options.endpoint, error, secret));
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(rejectedApiKeyMessage(options.endpoint));
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(httpFailureMessage(options.endpoint, response.status, response.text ?? "", secret));
  }

  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    throw new Error(`The ${options.endpoint} server returned a non-JSON response`);
  }
}
