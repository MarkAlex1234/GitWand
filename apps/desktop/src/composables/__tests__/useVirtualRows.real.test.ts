// @vitest-environment jsdom
/**
 * useVirtualRows against the REAL @tanstack/vue-virtual. Only layout is
 * stood in for (jsdom has none): the scroll element reports a 400px box.
 */
import { describe, it, expect } from "vitest";
import { createApp, defineComponent, h, nextTick, ref, type Ref } from "vue";
import { useVirtualRows } from "../useVirtualRows";

function mountRows(count: Ref<number>) {
  let api!: ReturnType<typeof useVirtualRows>;
  const Comp = defineComponent({
    setup() {
      const scrollEl = ref<HTMLElement | null>(null);
      api = useVirtualRows({
        count,
        getScrollElement: () => scrollEl.value,
        estimateSize: () => 24,
        overscan: 12,
      });
      return () => h("div", { ref: scrollEl });
    },
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(Comp);
  app.mount(host);
  const el = host.firstElementChild as HTMLElement;
  const rect = { width: 300, height: 400, top: 0, left: 0, right: 300, bottom: 400, x: 0, y: 0 };
  el.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect }) as DOMRect;
  Object.defineProperty(el, "offsetHeight", { value: 400 });
  Object.defineProperty(el, "offsetWidth", { value: 300 });
  return { api, app, host };
}

describe("useVirtualRows", () => {
  it("re-renders items and total size when the row count changes after mount", async () => {
    const count = ref(1);
    const { api, app, host } = mountRows(count);
    await nextTick();
    expect(api.virtualItems.value.length).toBe(1);
    expect(api.totalSize.value).toBe(24);

    count.value = 4;
    await nextTick();
    await nextTick();
    expect(api.virtualItems.value.length).toBe(4);
    expect(api.totalSize.value).toBe(96);
    app.unmount();
    host.remove();
  });
});
