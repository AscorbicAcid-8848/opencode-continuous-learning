// This entry is copied to <opencode-config>/plugins/continuous-learning.ts.
// The installer places the runtime beside plugins/ at continuous-learning-plugin/.
import plugin from "../continuous-learning-plugin/plugin.ts"

// OpenCode's stable loader treats every runtime export in a plugin entry as a
// plugin function, so this auto-discovered module intentionally exports only one.
export default plugin
