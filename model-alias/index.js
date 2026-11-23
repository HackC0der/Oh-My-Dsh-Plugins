/**
 * Host half of the model-alias bundle.
 *
 * Everything this bundle does happens in the browser: the Client half talks to
 * the running Host through the ordinary wire contracts (`remote.settings`,
 * `remote.llm`, `remote.credentials`) exactly like the built-in Models page
 * does. No Host service, config, or storage is added here, so the Host half
 * stays an empty plugin body.
 */
export function apply() {}
