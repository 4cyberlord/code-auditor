import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";

const council = defineContainer({
  name: "council",
  image: { dockerfile: "./container/Dockerfile", buildContext: ".." },
  instanceType: "lite",
  maxInstances: 1,
});

export default defineConfig({
  worker: {
    name: "council-editor-worker",
    compatibilityDate: "2026-10-14",
    entrypoint: "src/index.js",
    observability: { enabled: true },
    triggers: [triggers.scheduled({ schedule: "*/1 * * * *" })],
    env: {
      COUNCIL_WORKER: bindings.durableObject({
        worker: "council-editor-worker",
        exportName: "CouncilWorkerContainer",
      }),
    },
    exports: {
      CouncilWorkerContainer: exports.durableObject({
        storage: "sqlite",
        container: council,
      }),
    },
  },
  containers: [council],
});
