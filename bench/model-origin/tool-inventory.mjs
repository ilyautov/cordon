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

// A namespace can expose several model-callable tools while appearing as one
// top-level declaration. Keep only names and types, never prompt or schema text.
export function declaredToolSurface(request) {
  if (!Array.isArray(request?.tools)) return []
  return request.tools.map((tool) => {
    const valid = tool !== null && typeof tool === 'object' && !Array.isArray(tool)
    const type = valid && typeof tool.type === 'string' ? tool.type : null
    const name = valid ? tool.name ?? tool.function?.name : null
    const members = valid && Array.isArray(tool.tools) ? tool.tools.map((member) =>
      typeof member?.name === 'string' ? member.name : null) : []
    return { type, name: typeof name === 'string' ? name : null, members }
  })
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
