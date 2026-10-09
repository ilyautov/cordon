// Keep tool declarations from the model request without retaining its prompt.
export function declaredToolNames(request) {
  if (!Array.isArray(request?.tools)) return []
  const names = request.tools.flatMap((tool) => {
    if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) return []
    const name = tool.name ?? tool.function?.name
    if (typeof name === 'string' && name.length > 0) return [name]
    return typeof tool.type === 'string' && tool.type.length > 0 ? ['type:' + tool.type] : []
  })
  return [...new Set(names)].sort()
}

export function requestToolShape(request) {
  const keys = request !== null && typeof request === 'object' && !Array.isArray(request)
    ? Object.keys(request).sort() : []
  const tools = request?.tools
  return {
    keys,
    toolsKind: Array.isArray(tools) ? 'array' : tools === null ? 'null' : typeof tools,
    toolCount: Array.isArray(tools) ? tools.length : null,
    declaredToolNames: declaredToolNames(request),
  }
}
