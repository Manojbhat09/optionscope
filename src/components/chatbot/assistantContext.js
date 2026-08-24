// src/components/chatbot/assistantContext.js
//
// Per-page assistant context registry (see files/assistant-history-design.md).
// Each page registers a context supplier on mount and deregisters on unmount;
// the Chatbot asks the registry for the ACTIVE entry at send time. Pages never
// import the Chatbot and vice versa — the registry is the only contract.
//
// Entries live in refs so pages can pass inline closures without churning the
// registration effect every render: getContext()/target() always read the
// latest closures, reflecting whatever is currently on screen.

import { useEffect, useRef } from 'react';

export function createAssistantRegistry() {
  const entries = new Map(); // id -> { id, title, get(), target() }
  let activeId = 'dashboard';
  return {
    register(id, entry) { entries.set(id, entry); },
    unregister(id) { entries.delete(id); },
    byId(id) { return entries.get(id) || null; },
    // With keep-alive routing every page stays mounted, so "last registered"
    // means nothing — App.js pins the visible page here.
    set activeId(id) { if (entries.has(id) || !entries.size) activeId = id; },
    get activeId() { return activeId; },
    get active() {
      return entries.get(activeId)
        || (() => { let last = null; entries.forEach(e => { last = e; }); return last; })();
    },
  };
}

export function useAssistantContext(registry, { id, title, getContext, targetRef }) {
  const latest = useRef({ title, getContext, targetRef });
  latest.current = { title, getContext, targetRef };

  useEffect(() => {
    registry.register(id, {
      id,
      title: () => latest.current.title,
      getContext: () => {
        try { return latest.current.getContext?.() ?? null; } catch { return null; }
      },
      target: () => latest.current.targetRef?.current ?? null,
    });
    return () => registry.unregister(id);
  }, [registry, id]);
}
