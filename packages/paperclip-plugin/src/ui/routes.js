/** Build the Paperclip company page URL for this installed plugin instance. */
export function polyForgePageHref(pluginId) {
  return `/plugins/${encodeURIComponent(pluginId)}#health`;
}
