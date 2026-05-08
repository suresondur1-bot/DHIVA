import React from "react";

// ═══════════════════════════════════════════════════════════════════════════
// API Auth Helper - Simple Version
// SAVE AS: C:\Users\337799\Automation\frontend\src\api-testing\ApiAuthHelper.jsx
// ═══════════════════════════════════════════════════════════════════════════

export function ApiAuthHelper({ auth, onChange }) {
  // Simple auth helper - add Bearer token via headers instead
  
  return (
    <div style={{ padding: "10px", background: "#fef3c7", borderRadius: "6px", marginBottom: "15px" }}>
      <div style={{ fontSize: "13px", color: "#92400e" }}>
        💡 <strong>Authentication Tip:</strong> Add auth headers manually:
        <ul style={{ margin: "5px 0", paddingLeft: "20px" }}>
          <li>Bearer Token: Add header "Authorization" with value "Bearer {"{{token}}"}"</li>
          <li>API Key: Add header "X-API-Key" with value "{"{{api_key}}"}"</li>
        </ul>
      </div>
    </div>
  );
}
