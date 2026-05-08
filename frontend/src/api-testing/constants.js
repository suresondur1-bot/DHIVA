// ═══════════════════════════════════════════════════════════════════════════
// SAVE AS: C:\Users\337799\Automation\frontend\src\api-testing\constants.js
// ═══════════════════════════════════════════════════════════════════════════

export const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

export const AUTH_TYPES = [
  { value: "none", label: "No Authentication" },
  { value: "bearer", label: "Bearer Token" },
  { value: "basic", label: "Basic Auth" },
  { value: "api_key_header", label: "API Key in Header" },
  { value: "api_key_query", label: "API Key in Query" }
];

export const API_ASSERTIONS = [
  { value: "status_code", label: "✅ Status Code equals", group: "Status" },
  { value: "status_in_range", label: "✅ Status in range", group: "Status" },
  { value: "response_contains", label: "✅ Response contains", group: "Body" },
  { value: "response_matches", label: "🔍 Response matches regex", group: "Body" },
  { value: "json_key_exists", label: "✅ JSON key exists", group: "JSON" },
  { value: "json_value", label: "✅ JSON key=value", group: "JSON" },
  { value: "json_type", label: "📋 JSON field type", group: "JSON" },
  { value: "json_array_length", label: "🔢 Array length", group: "JSON" },
  { value: "header_exists", label: "✅ Header exists", group: "Headers" },
  { value: "header_equals", label: "✅ Header equals", group: "Headers" },
  { value: "response_time", label: "⚡ Response time <", group: "Performance" },
  { value: "extract_json", label: "📥 Extract JSON → Var", group: "Extract" },
  { value: "extract_header", label: "📥 Extract Header → Var", group: "Extract" },
  { value: "extract_cookie", label: "📥 Extract Cookie → Var", group: "Extract" }
];

export const DEFAULT_API_CONFIG = {
  method: "GET",
  url: "",
  headers: [],
  body: "",
  body_type: "json",
  auth: { type: "none" },
  assertions: [],
  environment_id: null,
  timeout: 30000
};

export const COMMON_HEADERS = [
  { key: "Content-Type", value: "application/json" },
  { key: "Authorization", value: "Bearer {{token}}" },
  { key: "Accept", value: "application/json" }
];
