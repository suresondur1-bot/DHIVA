import React, { useState, useEffect } from "react";
import { api, s, Badge } from "../shared.jsx";
import { HTTP_METHODS, DEFAULT_API_CONFIG, COMMON_HEADERS, AUTH_TYPES, API_ASSERTIONS } from "./constants.js";

export function ApiEditor({ config, onChange }) {
  // Ensure headers and assertions are always arrays
  const initialConfig = {
    ...DEFAULT_API_CONFIG,
    ...(config || {}),
    headers: Array.isArray(config?.headers) ? config.headers : [],
    assertions: Array.isArray(config?.assertions) ? config.assertions : [],
    auth: config?.auth || { type: "none" }
  };
  
  const [apiConfig, setApiConfig] = useState(initialConfig);
  const [environments, setEnvironments] = useState([]);

  useEffect(() => {
    loadEnvironments();
  }, []);

  useEffect(() => {
    if (onChange) onChange(apiConfig);
  }, [apiConfig]);

  async function loadEnvironments() {
    try {
      const envs = await api("/api/api-environments");
      setEnvironments(envs);
    } catch (err) {
      console.error("Failed to load environments:", err);
    }
  }

  const updateConfig = (field, value) => {
    setApiConfig(prev => ({ ...prev, [field]: value }));
  };

  const updateAuth = (field, value) => {
    setApiConfig(prev => ({
      ...prev,
      auth: { ...prev.auth, [field]: value }
    }));
  };

  const addHeader = () => {
    const headers = [...(apiConfig.headers || [])];
    headers.push({ key: "", value: "", enabled: true });
    updateConfig("headers", headers);
  };

  const updateHeader = (idx, field, value) => {
    const headers = [...(apiConfig.headers || [])];
    headers[idx] = { ...headers[idx], [field]: value };
    updateConfig("headers", headers);
  };

  const removeHeader = (idx) => {
    const headers = [...(apiConfig.headers || [])];
    headers.splice(idx, 1);
    updateConfig("headers", headers);
  };

  // === ASSERTIONS FUNCTIONS ===
  const addAssertion = () => {
    const assertions = [...(apiConfig.assertions || [])];
    assertions.push({ type: "status_code", value: "", key: "", path: "", variable: "" });
    updateConfig("assertions", assertions);
  };

  const updateAssertion = (idx, field, value) => {
    const assertions = [...(apiConfig.assertions || [])];
    assertions[idx] = { ...assertions[idx], [field]: value };
    updateConfig("assertions", assertions);
  };

  const removeAssertion = (idx) => {
    const assertions = [...(apiConfig.assertions || [])];
    assertions.splice(idx, 1);
    updateConfig("assertions", assertions);
  };

  const blue = "#1a6fc4";
  const gray = "#6b7280";
  const green = "#10b981";

  return (
    <div style={{ padding: "20px" }}>
      
      {/* Method + URL */}
      <div style={{ display: "flex", gap: "10px", marginBottom: "15px" }}>
        <select
          value={apiConfig.method || "GET"}
          onChange={e => updateConfig("method", e.target.value)}
          style={{ ...s.input, width: "120px", fontWeight: 600, color: blue }}
        >
          {HTTP_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>

        <input
          type="text"
          placeholder="https://api.example.com/endpoint"
          value={apiConfig.url || ""}
          onChange={e => updateConfig("url", e.target.value)}
          style={{ ...s.input, flex: 1 }}
        />
      </div>

      {/* Environment */}
      {environments.length > 0 && (
        <div style={{ marginBottom: "15px" }}>
          <label style={{ fontSize: "13px", color: gray, display: "block", marginBottom: "5px" }}>
            Environment (optional)
          </label>
          <select
            value={apiConfig.environment_id || ""}
            onChange={e => updateConfig("environment_id", e.target.value ? parseInt(e.target.value) : null)}
            style={s.input}
          >
            <option value="">None (use full URL)</option>
            {environments.map(env => (
              <option key={env.id} value={env.id}>{env.name} - {env.base_url}</option>
            ))}
          </select>
        </div>
      )}

      {/* ═══ AUTHENTICATION SECTION ═══ */}
      <div style={{ 
        marginBottom: "20px", 
        padding: "15px", 
        background: "#f9fafb", 
        border: "1px solid #e5e7eb",
        borderRadius: "8px"
      }}>
        <h3 style={{ margin: "0 0 15px 0", fontSize: "16px", fontWeight: 600 }}>
          🔐 Authentication
        </h3>

        <div style={{ marginBottom: "15px" }}>
          <label style={{ fontSize: "13px", color: gray, display: "block", marginBottom: "5px" }}>
            Auth Type
          </label>
          <select
            value={apiConfig.auth?.type || "none"}
            onChange={e => updateAuth("type", e.target.value)}
            style={s.input}
          >
            {AUTH_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        {apiConfig.auth?.type === "bearer" && (
          <div>
            <label style={{ fontSize: "13px", color: gray, display: "block", marginBottom: "5px" }}>
              Bearer Token
            </label>
            <input
              type="text"
              placeholder="Enter token or use {{variable}}"
              value={apiConfig.auth?.token || ""}
              onChange={e => updateAuth("token", e.target.value)}
              style={{ ...s.input, fontFamily: "monospace" }}
            />
            <div style={{ fontSize: "12px", color: gray, marginTop: "5px" }}>
              💡 Use variables like {"{{token}}"} or {"{{access_token}}"}
            </div>
          </div>
        )}

        {apiConfig.auth?.type === "basic" && (
          <div>
            <div style={{ marginBottom: "10px" }}>
              <label style={{ fontSize: "13px", color: gray, display: "block", marginBottom: "5px" }}>
                Username
              </label>
              <input
                type="text"
                placeholder="Enter username or {{username}}"
                value={apiConfig.auth?.username || ""}
                onChange={e => updateAuth("username", e.target.value)}
                style={s.input}
              />
            </div>
            <div>
              <label style={{ fontSize: "13px", color: gray, display: "block", marginBottom: "5px" }}>
                Password
              </label>
              <input
                type="password"
                placeholder="Enter password or {{password}}"
                value={apiConfig.auth?.password || ""}
                onChange={e => updateAuth("password", e.target.value)}
                style={s.input}
              />
            </div>
          </div>
        )}

        {apiConfig.auth?.type === "api_key_header" && (
          <div>
            <div style={{ marginBottom: "10px" }}>
              <label style={{ fontSize: "13px", color: gray, display: "block", marginBottom: "5px" }}>
                Header Name
              </label>
              <input
                type="text"
                placeholder="e.g., X-API-Key"
                value={apiConfig.auth?.key_name || "X-API-Key"}
                onChange={e => updateAuth("key_name", e.target.value)}
                style={s.input}
              />
            </div>
            <div>
              <label style={{ fontSize: "13px", color: gray, display: "block", marginBottom: "5px" }}>
                API Key Value
              </label>
              <input
                type="text"
                placeholder="Enter API key or {{api_key}}"
                value={apiConfig.auth?.key_value || ""}
                onChange={e => updateAuth("key_value", e.target.value)}
                style={{ ...s.input, fontFamily: "monospace" }}
              />
            </div>
          </div>
        )}

        {apiConfig.auth?.type === "api_key_query" && (
          <div>
            <div style={{ marginBottom: "10px" }}>
              <label style={{ fontSize: "13px", color: gray, display: "block", marginBottom: "5px" }}>
                Query Parameter Name
              </label>
              <input
                type="text"
                placeholder="e.g., api_key"
                value={apiConfig.auth?.param_name || "api_key"}
                onChange={e => updateAuth("param_name", e.target.value)}
                style={s.input}
              />
            </div>
            <div>
              <label style={{ fontSize: "13px", color: gray, display: "block", marginBottom: "5px" }}>
                API Key Value
              </label>
              <input
                type="text"
                placeholder="Enter API key or {{api_key}}"
                value={apiConfig.auth?.key_value || ""}
                onChange={e => updateAuth("key_value", e.target.value)}
                style={{ ...s.input, fontFamily: "monospace" }}
              />
            </div>
          </div>
        )}

        {apiConfig.auth?.type === "none" && (
          <div style={{ 
            padding: "10px", 
            background: "#f0f9ff", 
            border: "1px solid #bae6fd",
            borderRadius: "6px",
            fontSize: "13px",
            color: "#0369a1"
          }}>
            ℹ️ No authentication selected.
          </div>
        )}
      </div>

      {/* Headers */}
      <div style={{ marginBottom: "20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "10px" }}>
          <h3 style={{ margin: 0, fontSize: "16px" }}>📋 Headers</h3>
          <button onClick={addHeader} style={{ ...s.btn, padding: "6px 12px", fontSize: "12px" }}>
            + Add Header
          </button>
        </div>

        {(apiConfig.headers || []).map((header, idx) => (
          <div key={idx} style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
            <input
              type="text"
              placeholder="Header name"
              value={header.key || ""}
              onChange={e => updateHeader(idx, "key", e.target.value)}
              style={{ ...s.input, flex: 1 }}
            />
            <input
              type="text"
              placeholder="Value (use {{variables}})"
              value={header.value || ""}
              onChange={e => updateHeader(idx, "value", e.target.value)}
              style={{ ...s.input, flex: 2 }}
            />
            <button
              onClick={() => removeHeader(idx)}
              style={{ ...s.btn, background: "#fee", color: "#c00", padding: "8px 12px" }}
            >
              ✖
            </button>
          </div>
        ))}
      </div>

      {/* Body */}
      {["POST", "PUT", "PATCH"].includes(apiConfig.method) && (
        <div style={{ marginBottom: "20px" }}>
          <h3 style={{ margin: "0 0 10px 0", fontSize: "16px" }}>📦 Request Body</h3>
          <textarea
            placeholder='{\n  "key": "value",\n  "user": "{{username}}"\n}'
            value={apiConfig.body || ""}
            onChange={e => updateConfig("body", e.target.value)}
            style={{
              ...s.input,
              fontFamily: "monospace",
              fontSize: "13px",
              minHeight: "150px"
            }}
          />
        </div>
      )}

      {/* ═══ ASSERTIONS SECTION ═══ */}
      <div style={{ marginBottom: "20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "10px" }}>
          <h3 style={{ margin: 0, fontSize: "16px" }}>✅ Assertions</h3>
          <button onClick={addAssertion} style={{ ...s.btn, padding: "6px 12px", fontSize: "12px" }}>
            + Add Assertion
          </button>
        </div>

        {(apiConfig.assertions || []).map((assertion, idx) => (
          <div key={idx} style={{ 
            padding: "12px", 
            background: "#f9fafb", 
            border: "1px solid #e5e7eb", 
            borderRadius: "6px", 
            marginBottom: "10px" 
          }}>
            <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
              <select
                value={assertion.type || "status_code"}
                onChange={e => updateAssertion(idx, "type", e.target.value)}
                style={{ ...s.input, flex: 1 }}
              >
                {API_ASSERTIONS.map(a => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
              <button
                onClick={() => removeAssertion(idx)}
                style={{ ...s.btn, background: "#fee", color: "#c00", padding: "8px 12px" }}
              >
                ✖
              </button>
            </div>

            {/* Dynamic fields based on assertion type */}
            {["status_code", "response_contains", "response_time", "header_equals"].includes(assertion.type) && (
              <input
                type="text"
                placeholder={
                  assertion.type === "status_code" ? "e.g., 200" :
                  assertion.type === "response_time" ? "Max milliseconds (e.g., 1000)" :
                  "Expected value"
                }
                value={assertion.value || ""}
                onChange={e => updateAssertion(idx, "value", e.target.value)}
                style={{ ...s.input, width: "100%" }}
              />
            )}

            {["json_key_exists", "json_value", "header_exists", "header_equals"].includes(assertion.type) && (
              <input
                type="text"
                placeholder={assertion.type.includes("header") ? "Header name" : "JSON path (e.g., data.user.id)"}
                value={assertion.key || ""}
                onChange={e => updateAssertion(idx, "key", e.target.value)}
                style={{ ...s.input, width: "100%", marginTop: "8px" }}
              />
            )}

            {assertion.type === "json_value" && (
              <input
                type="text"
                placeholder="Expected value"
                value={assertion.value || ""}
                onChange={e => updateAssertion(idx, "value", e.target.value)}
                style={{ ...s.input, width: "100%", marginTop: "8px" }}
              />
            )}

            {assertion.type === "json_array_length" && (
              <>
                <input
                  type="text"
                  placeholder="Array path (e.g., data.items)"
                  value={assertion.path || ""}
                  onChange={e => updateAssertion(idx, "path", e.target.value)}
                  style={{ ...s.input, width: "100%", marginTop: "8px" }}
                />
                <input
                  type="number"
                  placeholder="Expected length"
                  value={assertion.length || ""}
                  onChange={e => updateAssertion(idx, "length", e.target.value)}
                  style={{ ...s.input, width: "100%", marginTop: "8px" }}
                />
              </>
            )}

            {assertion.type === "status_in_range" && (
              <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                <input
                  type="number"
                  placeholder="Min (e.g., 200)"
                  value={assertion.min || ""}
                  onChange={e => updateAssertion(idx, "min", e.target.value)}
                  style={{ ...s.input, flex: 1 }}
                />
                <input
                  type="number"
                  placeholder="Max (e.g., 299)"
                  value={assertion.max || ""}
                  onChange={e => updateAssertion(idx, "max", e.target.value)}
                  style={{ ...s.input, flex: 1 }}
                />
              </div>
            )}

            {["extract_json", "extract_header", "extract_cookie"].includes(assertion.type) && (
              <>
                <input
                  type="text"
                  placeholder={
                    assertion.type === "extract_json" ? "JSON path (e.g., data.token)" :
                    assertion.type === "extract_header" ? "Header name" :
                    "Cookie name"
                  }
                  value={assertion.type === "extract_json" ? assertion.path : assertion.key || ""}
                  onChange={e => updateAssertion(idx, assertion.type === "extract_json" ? "path" : "key", e.target.value)}
                  style={{ ...s.input, width: "100%", marginTop: "8px" }}
                />
                <input
                  type="text"
                  placeholder="Variable name to store (e.g., auth_token)"
                  value={assertion.variable || ""}
                  onChange={e => updateAssertion(idx, "variable", e.target.value)}
                  style={{ ...s.input, width: "100%", marginTop: "8px" }}
                />
              </>
            )}

            {assertion.type === "response_matches" && (
              <input
                type="text"
                placeholder="Regex pattern (e.g., ^[0-9]+$)"
                value={assertion.pattern || ""}
                onChange={e => updateAssertion(idx, "pattern", e.target.value)}
                style={{ ...s.input, width: "100%", marginTop: "8px" }}
              />
            )}
          </div>
        ))}

        {(apiConfig.assertions || []).length === 0 && (
          <div style={{ 
            padding: "20px", 
            textAlign: "center", 
            color: gray, 
            fontSize: "13px", 
            background: "#f9fafb", 
            borderRadius: "6px",
            border: "1px dashed #d1d5db"
          }}>
            No assertions added. Click "+ Add Assertion" to validate API responses.
          </div>
        )}
      </div>
    </div>
  );
}
