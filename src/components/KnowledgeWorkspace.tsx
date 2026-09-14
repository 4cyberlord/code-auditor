"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Markdown from "./Markdown";
import Splitter from "./Splitter";
import { useStore } from "@/lib/store";
import { markdownToRecord } from "@/lib/knowledgeDoc";

/**
 * The sidebar's furniture.
 *
 * Line icons rather than emoji: emoji are a different typeface at a different
 * weight, they render differently on every machine, and a column of them reads
 * as decoration. These inherit the row's colour, so a selected row's icon is
 * selected too.
 */
function Icon({ name }: { name: "all" | "folder" | "kind" | "tag" }) {
  const paths: Record<string, ReactNode> = {
    all: (
      <>
        <path d="M2 4.5h12M2 8h12M2 11.5h8" />
      </>
    ),
    folder: <path d="M2 4.2h4.2l1.2 1.6H14v7.4H2z" />,
    kind: (
      <>
        <circle cx="5.2" cy="5.2" r="2.4" />
        <rect x="8.8" y="8.8" width="4.8" height="4.8" rx="1" />
      </>
    ),
    tag: (
      <>
        <path d="M8.4 2.4H13.6V7.6L7.6 13.6 2.4 8.4z" />
        <circle cx="10.6" cy="5.4" r="0.9" />
      </>
    ),
  };
  return (
    <svg className="kn-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

/**
 * One group of filters, with its own disclosure.
 *
 * A library grows lopsided — forty tags and three collections — and a sidebar
 * that cannot be folded makes the part you are not using push the part you are
 * off the bottom of the window. The chevron is on the heading because that is
 * where a person reaches for it.
 */
function RailSection({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  if (!count) return null;
  return (
    <section className="kn-group" data-open={open}>
      <button className="kn-group-head" onClick={onToggle} aria-expanded={open}>
        <span>{title}</span>
        <span className="kn-count">{count}</span>
        <svg className="kn-chev" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.5 6.5L8 10l3.5-3.5" />
        </svg>
      </button>
      {open && <div className="kn-group-body">{children}</div>}
    </section>
  );
}

/**
 * The knowledge library, as a place you write rather than a file you deploy.
 *
 * Three panes for the same reason every library app has three: what to filter
 * by, what is in it, and the one you are reading. The editor is markdown
 * because the records are prose with a little structure, and typing prose into
 * nine form fields is how a library stops being added to.
 *
 * What you write is a file on your Mac the moment you save it, and the desktop
 * council can use it immediately. Publishing to the database the cloud worker
 * reads is deliberate and separate — `scripts/seed-knowledge.mjs` — so an
 * unfinished thought is never in front of a running job.
 */
export default function KnowledgeWorkspace({ active }: { active: boolean }) {
  const knowledge = useStore((s) => s.knowledge);
  const load = useStore((s) => s.loadKnowledge);
  const select = useStore((s) => s.selectKnowledge);
  const create = useStore((s) => s.newKnowledge);
  const edit = useStore((s) => s.editKnowledge);
  const save = useStore((s) => s.saveKnowledge);
  const remove = useStore((s) => s.deleteKnowledge);
  const importBundled = useStore((s) => s.importBundledKnowledge);
  const sync = useStore((s) => s.syncKnowledge);

  const [filter, setFilter] = useState<{ kind: "all" | "tag" | "type" | "collection"; value: string }>({
    kind: "all",
    value: "",
  });
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState(false);
  const [open, setOpen] = useState({ collections: true, kinds: true, tags: true });
  const toggle = (key: keyof typeof open) => setOpen((o) => ({ ...o, [key]: !o[key] }));

  // Read the folder when the tab is first opened, not on app start: a library
  // nobody looked at should not cost a disk read on every launch.
  useEffect(() => {
    if (active && !knowledge.folder && !knowledge.loading) void load();
  }, [active, knowledge.folder, knowledge.loading, load]);

  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of knowledge.entries) {
      for (const tag of entry.record.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [knowledge.entries]);

  // Collections first in the sidebar, because "the AWS ones" is how a person
  // looks for a record and "the pattern ones" is not.
  const collections = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of knowledge.entries) {
      const name = entry.category || "Uncollected";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => {
      // Built-in last: it is the shelf you did not write.
      if ((a[0] === "Built-in") !== (b[0] === "Built-in")) return a[0] === "Built-in" ? 1 : -1;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    });
  }, [knowledge.entries]);

  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of knowledge.entries) counts.set(entry.record.kind, (counts.get(entry.record.kind) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [knowledge.entries]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return knowledge.entries.filter((entry) => {
      if (filter.kind === "collection" && (entry.category || "Uncollected") !== filter.value) return false;
      if (filter.kind === "tag" && !entry.record.tags.includes(filter.value)) return false;
      if (filter.kind === "type" && entry.record.kind !== filter.value) return false;
      if (!q) return true;
      return (
        entry.record.title.toLowerCase().includes(q) ||
        entry.id.includes(q) ||
        entry.record.summary.toLowerCase().includes(q) ||
        entry.record.tags.some((t) => t.includes(q))
      );
    });
  }, [knowledge.entries, filter, query]);

  // The draft is the truth while you are typing, so the header reads from it
  // rather than from the file it came from.
  const draftRecord = useMemo(() => markdownToRecord(knowledge.draft), [knowledge.draft]);
  const isNew = !knowledge.selectedId;

  return (
    <div className="knowledge">
      <aside className="kn-rail">
        <div className="kn-rail-head">
          <span className="section-label" style={{ margin: 0 }}>
            Library
          </span>
          <span className="kn-count">{knowledge.entries.length}</span>
        </div>

        <button
          className="kn-filter"
          data-on={filter.kind === "all"}
          onClick={() => setFilter({ kind: "all", value: "" })}
        >
          <Icon name="all" />
          <span className="kn-filter-text">All Records</span>
          <span className="kn-count">{knowledge.entries.length}</span>
        </button>

        <RailSection title="Collections" count={collections.length} open={open.collections} onToggle={() => toggle("collections")}>
          {collections.map(([name, n]) => (
            <button
              key={name}
              className="kn-filter"
              data-on={filter.kind === "collection" && filter.value === name}
              onClick={() => setFilter({ kind: "collection", value: name })}
              title={name === "Built-in" ? "The library compiled into this build" : `Knowledge/${name}`}
            >
              <Icon name="folder" />
              <span className="kn-filter-text">{name}</span>
              <span className="kn-count">{n}</span>
            </button>
          ))}
        </RailSection>

        <RailSection title="Kinds" count={kinds.length} open={open.kinds} onToggle={() => toggle("kinds")}>
          {kinds.map(([kind, n]) => (
            <button
              key={kind}
              className="kn-filter"
              data-on={filter.kind === "type" && filter.value === kind}
              onClick={() => setFilter({ kind: "type", value: kind })}
            >
              <Icon name="kind" />
              <span className="kn-filter-text">{kind}</span>
              <span className="kn-count">{n}</span>
            </button>
          ))}
        </RailSection>

        <RailSection title="Tags" count={tags.length} open={open.tags} onToggle={() => toggle("tags")}>
          {tags.map(([tag, n]) => (
            <button
              key={tag}
              className="kn-filter"
              data-on={filter.kind === "tag" && filter.value === tag}
              onClick={() => setFilter({ kind: "tag", value: tag })}
            >
              <Icon name="tag" />
              <span className="kn-filter-text">{tag}</span>
              <span className="kn-count">{n}</span>
            </button>
          ))}
        </RailSection>

        {knowledge.entries.length > 0 && knowledge.entries.every((e) => e.source === "built-in") && (
          <button
            className="kn-filter kn-import"
            onClick={() => void importBundled()}
            disabled={knowledge.saving}
            title="Write the built-in records into your folder so you can edit them"
          >
            {knowledge.saving ? "Copying…" : "Copy Built-in to My Folder"}
          </button>
        )}

        {knowledge.folder && (
          <div className="kn-folder" title={knowledge.folder}>
            Knowledge Folder
          </div>
        )}
      </aside>

      <section className="kn-list">
        {/* A search field, not a box in a bar: the row *is* the field, the way a
            library app does it. The rule under it is the only edge, so the
            header reads as part of the list rather than a widget parked on top
            of it. */}
        <div className="kn-list-head">
          <svg className="kn-search-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <circle cx="7.2" cy="7.2" r="4.3" />
            <path d="M10.4 10.4L13.4 13.4" />
          </svg>
          <input
            id="knowledge-search"
            className="kn-search"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="kn-icon-btn" onClick={() => setQuery("")} title="Clear the search" aria-label="Clear the search">
              <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
              </svg>
            </button>
          )}
          <button className="kn-icon-btn" onClick={create} title="Write a new record" aria-label="Write a new record">
            <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M8 3.4v9.2M3.4 8h9.2" />
            </svg>
          </button>
        </div>

        {knowledge.loading && knowledge.entries.length === 0 && <div className="empty compact">Reading the folder…</div>}
        {!knowledge.loading && shown.length === 0 && (
          <div className="empty compact">
            {knowledge.entries.length === 0
              ? "Nothing here yet. Write the first record — it reaches the models on the next run."
              : "Nothing matches that."}
          </div>
        )}

        {shown.map((entry) => (
          <button
            key={entry.id}
            className="kn-item"
            data-on={entry.id === knowledge.selectedId}
            onClick={() => select(entry.id)}
          >
            <span className="kn-item-title">{entry.record.title || entry.id}</span>
            <span className="kn-item-tags">
              {entry.record.tags.slice(0, 3).map((tag) => (
                <span key={tag} className="chip">
                  {tag}
                </span>
              ))}
              {entry.source === "built-in" && (
                <span className="chip" title="Compiled into this build. Editing it writes a copy to your folder.">
                  built-in
                </span>
              )}
              {entry.problems.length > 0 && (
                <span className="chip" data-tone="warn" title={entry.problems.join("\n")}>
                  {entry.problems.length} to fix
                </span>
              )}
            </span>
            <span className="kn-item-foot">
              <span>{entry.record.kind}</span>
              {/* A built-in record has never been written, so it has no edit
                  time. Formatting the zero gave every one of them 12/31/1969,
                  which is a date nobody meant and everybody reads twice. */}
              <span>{entry.updatedAt > 0 ? new Date(entry.updatedAt).toLocaleDateString() : "ships with the app"}</span>
            </span>
          </button>
        ))}
      </section>

      <Splitter
        axis="col"
        variable="--kn-list-w"
        min={260}
        max={1100}
        reset={420}
        storageKey="code-auditor.layout.knowledge-list"
      />

      <section className="kn-editor">
        <div className="kn-editor-head">
          <div className="kn-editor-title">
            <strong>{draftRecord.record.title || (isNew ? "New record" : knowledge.selectedId)}</strong>
            <span className="kn-id">{draftRecord.record.id || "no id yet"}</span>
          </div>
          <span className="spacer" />
          {!isNew && knowledge.entries.find((e) => e.id === knowledge.selectedId)?.source === "built-in" && (
            <span className="kn-state" title="Saving writes your own copy into the knowledge folder.">
              built-in
            </span>
          )}
          {knowledge.dirty && <span className="kn-state">unsaved</span>}
          {!knowledge.dirty && knowledge.savedAt && <span className="kn-state" data-tone="good">saved</span>}
          <button className="btn tiny ghost" data-on={preview} onClick={() => setPreview((v) => !v)}>
            {preview ? "Edit" : "Preview"}
          </button>
          {!isNew && (
            <button
              className="btn tiny ghost"
              onClick={() => void remove(knowledge.selectedId)}
              title="Delete this record's file"
            >
              Delete
            </button>
          )}
          <button className="btn tiny" onClick={() => void save()} disabled={knowledge.saving || !knowledge.dirty}>
            {knowledge.saving ? "Saving…" : "Save"}
          </button>
        </div>

        {knowledge.error && <div className="pane-error">{knowledge.error}</div>}

        {preview ? (
          <div className="kn-preview">
            <Markdown text={knowledge.draft} />
          </div>
        ) : (
          <textarea
            id="knowledge-editor"
            className="kn-text"
            spellCheck={false}
            value={knowledge.draft}
            placeholder="Write the record here."
            onChange={(e) => edit(e.target.value)}
          />
        )}

        {/* Problems, not errors. Every one of these saves fine; they are the
            difference between a record that will be retrieved and one that sits
            in the folder being ignored. */}
        {draftRecord.problems.length > 0 && (
          <ul className="kn-problems">
            {draftRecord.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}

        {/* Two homes, two moments. Saving writes a file this app reads on its
            next run; publishing is what puts the library in front of cloud
            jobs, and it stays a button rather than a background sync so an
            unfinished note never reaches one. */}
        <div className="kn-foot">
          <span className="kn-hint">
            {knowledge.syncNote ||
              "Saved to your knowledge folder and used by this app on the next run. Publish to reach cloud jobs."}
          </span>
          <span className="spacer" />
          {knowledge.syncedAt && !knowledge.syncing && (
            <span className="kn-state" data-tone="good">
              published {new Date(knowledge.syncedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            className="btn tiny"
            onClick={() => void sync()}
            disabled={knowledge.syncing || knowledge.entries.length === 0}
            title="Publish every finished record to the database the cloud worker reads"
          >
            {knowledge.syncing ? "Publishing…" : "Publish to Cloud"}
          </button>
        </div>
      </section>
    </div>
  );
}
