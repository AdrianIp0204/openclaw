// Private host state must stay out of plugin attempts and settled-turn finalizers.
export const privateHarnessParamCases = [
  {
    field: "runtimePluginToolGrant",
    value: { pluginId: "grant-owner", toolNames: ["optional_tool"] },
  },
  { field: "__openclawSourceReplyDeliveryRuntime", value: { currentMode: "automatic" } },
  {
    field: "memoryFlushAppendBudget",
    value: { acceptedChars: -10_000, acceptedLines: -10_000 },
  },
  { field: "compactionCountOwner", value: "caller" },
  { field: "onContextAccountingEvent", value: () => undefined },
  { field: "onCompactionRequestBudget", value: () => undefined },
] as const;
