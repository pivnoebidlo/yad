<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    badge?: string | number;
    collapsed: boolean;
    ontoggle: () => void;
    style?: string;
    children: Snippet;
  }
  let { title, badge, collapsed, ontoggle, style = "", children }: Props = $props();
</script>

<section class="sec" {style}>
  <button class="head" onclick={ontoggle} aria-expanded={!collapsed} title={collapsed ? `Show ${title}` : `Hide ${title}`}>
    <span class="chev" class:closed={collapsed}>▾</span>
    <span class="title">{title}</span>
    {#if badge !== undefined && badge !== ""}<span class="badge">{badge}</span>{/if}
  </button>
  <!-- Hidden, not unmounted: keeps scroll position and filters. -->
  <div class="body" class:hidden={collapsed}>{@render children()}</div>
</section>

<style>
  .sec { display: flex; flex-direction: column; min-height: 0; border-bottom: 1px solid var(--border); }
  .head { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 6px; padding: 4px 8px; cursor: default;
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); flex: none; }
  .head:hover { color: var(--text); }
  .chev { display: inline-block; width: 10px; transition: transform 0.1s; }
  .chev.closed { transform: rotate(-90deg); }
  .badge { font-weight: 400; text-transform: none; letter-spacing: 0; }
  .body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .body.hidden { display: none; }
</style>
