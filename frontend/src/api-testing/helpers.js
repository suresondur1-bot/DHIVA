// ═══════════════════════════════════════════════════════════════════════════
// API Testing Helper Functions
// SAVE AS: C:\Users\337799\Automation\frontend\src\api-testing\helpers.js
// ═══════════════════════════════════════════════════════════════════════════

export function substituteVariables(text, variables) {
  if (!text || typeof text !== 'string') return text;
  
  let result = text;
  Object.entries(variables || {}).forEach(([key, value]) => {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
  });
  
  return result;
}

export function parseJsonPath(obj, path) {
  if (!path) return obj;
  
  const keys = path.split('.');
  let current = obj;
  
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  
  return current;
}

export function formatResponse(response) {
  try {
    if (typeof response === 'string') {
      return JSON.stringify(JSON.parse(response), null, 2);
    }
    return JSON.stringify(response, null, 2);
  } catch {
    return response;
  }
}
