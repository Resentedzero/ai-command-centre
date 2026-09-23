"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { applyWorldTemplate, createWorld, getRegistry, getWorld, renameWorkspace, saveWorldItem, type AppearanceOptions, type WorldData, type WorldKind } from "../../lib/api";
import { PixelButton, Skeleton, StateNotice, cx, px } from "../../components/pixel/Pixel";
import { usePreferences } from "../../components/preferences";
import { KEEP, errorText } from "../../lib/keep";
import { WINDOW_CHOICES, windowWords, type Preferences } from "../../lib/preferences";
import st from "./settings.module.css";
import { AgentHoursSettings, NotificationSettings, RoleIconSettings, WorkplaceClockSettings, WorkplaceRooms } from "./WorkplaceSettings";

const MAP_SCALE = 1 / 3;

type Selection = { kind: WorldKind; id: string } | { kind: WorldKind; id: null; parentId: string | null } | null;

const FIELDS: Record<WorldKind, string[]> = {
  buildings: ["x", "y", "w", "h"],
  areas: ["x", "y", "w", "h"],
  workstations: ["x", "y"],
};

const SECTIONS = ["general", "workplace", "agents", "notifications", "world", "system"] as const;
type Section = (typeof SECTIONS)[number];

/**
 * Settings (plan §13–14). Motion, name tags, ambient life, a new recruit's starting look and the
 * current-work window are this browser's presentation preferences (`lib/preferences.ts`). The Keep's
 * clock, rooms, working hours and notifications (workplace) and World are saved for everyone by the API.
 * Nothing on any section grants an agent anything or changes how it is governed: permissions, budgets
 * and Policy stay in the governance screens.
 */
export default function SettingsPage() {
  const [section, setSection] = useState<Section>("general");
  useEffect(() => {
    const fromHash = () => {
      const s = window.location.hash.slice(1) as Section;
      if (SECTIONS.includes(s)) setSection(s);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  const choose = (s: Section) => {
    setSection(s);
    try {
      window.history.replaceState(null, "", `#${s}`);
    } catch {
      // No history API (tests): the section still changes.
    }
  };
  return (
    <main className={st.screen}>
      <nav className={cx(px.board, st.sections)} aria-label="Settings sections">
        <span className={px.tab}>Settings</span>
        {SECTIONS.map((s) => (
          <button key={s} type="button" className={cx(st.section, section === s && st.sectionActive)} aria-current={section === s ? "page" : undefined} onClick={() => choose(s)}>
            {s[0]!.toUpperCase() + s.slice(1)}
          </button>
        ))}
        <p className={px.detail}>Display preferences are saved in this browser. The Keep&apos;s clock, rooms, working hours, notifications and World are saved for everyone.</p>
      </nav>
      {section === "general" ? (
        <GeneralSettings />
      ) : section === "workplace" ? (
        <section className={cx(px.board, st.world)} aria-label="Workplace">
          <h1 className={px.heading}>Workplace</h1>
          <WorkplaceRooms />
        </section>
      ) : section === "notifications" ? (
        <section className={cx(px.board, st.world)} aria-label="Notifications">
          <h1 className={px.heading}>Notifications</h1>
          <NotificationSettings />
        </section>
      ) : section === "world" ? (
        <WorldSettings />
      ) : section === "agents" ? (
        <AgentSettings />
      ) : (
        <SystemSettings />
      )}
    </main>
  );
}

function Choice<K extends keyof Preferences>({ label, detail, field, options }: { label: string; detail: string; field: K; options: [Preferences[K], string][] }) {
  const { preferences, update } = usePreferences();
  return (
    <div className={st.field}>
      <label className={st.field}>
        <span className={px.label}>{label}</span>
        <select
          className={px.input}
          value={String(preferences[field])}
          onChange={(e) =>
            update({
              [field]: options.find(([v]) => String(v) === e.target.value)![0],
            } as Partial<Preferences>)
          }
        >
          {options.map(([v, words]) => (
            <option key={String(v)} value={String(v)}>
              {words}
            </option>
          ))}
        </select>
      </label>
      <span className={px.detail}>{detail}</span>
    </div>
  );
}

function GeneralSettings() {
  return (
    <section className={cx(px.board, st.world)} aria-label="General">
      <h1 className={px.heading}>General</h1>
      <Choice
        label="Motion"
        field="motion"
        detail="Reduced stops every animation and walk: characters appear where they are going."
        options={[
          ["system", "follow this device's setting"],
          ["reduced", "reduced"],
          ["full", "full"],
        ]}
      />
      <Choice
        label="Ambient life"
        field="ambient"
        detail="Idle agents walk between the living areas. Off, they stay where they are; real work still sends them to their desks."
        options={[
          [true, "on"],
          [false, "off"],
        ]}
      />
      <Choice
        label="Name tags in the world"
        field="nameTags"
        detail="Real work is always named in each character's label for screen readers and on hover."
        options={[
          ["real", "agents doing real work"],
          ["all", "every agent"],
          ["none", "none (selected agent only)"],
        ]}
      />
      <WorkplaceClockSettings />
    </section>
  );
}

function AgentSettings() {
  const [options, setOptions] = useState<AppearanceOptions | null | "error">(null);
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    getRegistry()
      .then((r) => {
        setOptions(r.builder?.appearance ?? "error");
        setNames([...new Set(r.agentDefinitions.map((a) => a.name))].sort());
      })
      .catch(() => setOptions("error"));
  }, []);
  return (
    <section className={cx(px.board, st.world)} aria-label="Agents">
      <h1 className={px.heading}>Agents</h1>
      <p className={px.detail}>How new agents look when you recruit them. Looks never change what an agent may do, spend or use.</p>
      {options === null ? (
        <Skeleton />
      ) : options === "error" ? (
        <StateNotice role="alert" message="Couldn't read the character catalogue." />
      ) : (
        <>
          <Choice
            label="A new recruit starts as"
            field="recruitPreset"
            detail="You can still change every part in the Agent Builder."
            options={[["", "the catalogue defaults"], ...(options.presets ?? []).map((p) => [p.id, p.name] as [string, string])]}
          />
          <p className={px.detail}>
            The catalogue: {Object.values(options.parts).reduce((n, p) => n + p.options.length, 0)} options across {Object.keys(options.parts).length} parts,{" "}
            {options.presets?.length ?? 0} presets. <Link href="/agents/new">Recruit an agent</Link>
          </p>
        </>
      )}
      <RoleIconSettings />
      <AgentHoursSettings agents={names} />
    </section>
  );
}

function SystemSettings() {
  const { preferences } = usePreferences();
  return (
    <section className={cx(px.board, st.world)} aria-label="System">
      <h1 className={px.heading}>System</h1>
      <Choice
        label="Current work"
        field="currentWindowHours"
        detail={`Overview, Goals and Workflows show unfinished work and work active in ${windowWords(preferences.currentWindowHours)}. Nothing is archived or hidden: everything stays in History.`}
        options={WINDOW_CHOICES.map((h) => [h, h === 0 ? "all unarchived work" : windowWords(h)] as [number, string])}
      />
      <p className={px.detail}>
        To move a backlog of finished work out of every list for good, archive it from <Link href="/history">History</Link>. Nothing is archived automatically.
      </p>
    </section>
  );
}

/**
 * World: the physical Command Centre the agents live in — its buildings, the areas inside them
 * (work, common, rest, social, waiting, corridor) and the workstations where real work is drawn.
 * Space only: nothing here grants an agent anything or changes how it is governed. Every edit is
 * validated by the API and persists; nothing is deleted, only deactivated or retired.
 */
function WorldSettings() {
  const [world, setWorld] = useState<WorldData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");

  const load = useCallback(async () => {
    try {
      const w = await getWorld();
      setWorld(w);
      setWorkspaceName(w.workspace?.name ?? "");
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const saved = world?.workspace !== null && world !== null;
  const view = world
    ? world.workspace
      ? world
      : {
          ...world,
          ...(world.preview ?? { buildings: [], areas: [], workstations: [] }),
        }
    : null;

  const selectedItem = useMemo(() => {
    if (!view || !selection || selection.id === null) return null;
    const list: Record<string, unknown>[] = selection.kind === "buildings" ? view.buildings : selection.kind === "areas" ? view.areas : view.workstations;
    return list.find((i) => i.id === selection.id) ?? null;
  }, [view, selection]);

  function select(next: Selection) {
    setSelection(next);
    setSaveError(null);
    setNotice(null);
    if (!next || !view) return setDraft({});
    if (next.id === null) {
      const parentArea = next.kind === "workstations" ? view.areas.find((a) => a.id === next.parentId) : undefined;
      const parentBuilding = next.kind === "areas" ? view.buildings.find((b) => b.id === next.parentId) : undefined;
      setDraft(
        next.kind === "buildings"
          ? { name: "", x: "0", y: "0", w: "200", h: "160" }
          : next.kind === "areas"
            ? {
                name: "",
                purpose: "common",
                x: String(parentBuilding?.x ?? 0),
                y: String(parentBuilding?.y ?? 0),
                w: "120",
                h: "80",
              }
            : {
                name: "",
                activity: "generic",
                facing: "up",
                x: String(Math.round((parentArea?.x ?? 0) + (parentArea?.w ?? 0) / 2)),
                y: String(Math.round((parentArea?.y ?? 0) + (parentArea?.h ?? 0) / 2)),
              },
      );
      return;
    }
    const list: Record<string, unknown>[] = next.kind === "buildings" ? view.buildings : next.kind === "areas" ? view.areas : view.workstations;
    const item = list.find((i) => i.id === next.id);
    setDraft(
      Object.fromEntries(
        Object.entries(item ?? {})
          .filter(([k]) => ["name", "purpose", "activity", "facing", "x", "y", "w", "h", "areaId"].includes(k))
          .map(([k, v]) => [k, String(v)]),
      ),
    );
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!selection) return;
    setBusy(true);
    setSaveError(null);
    try {
      const fields: Record<string, unknown> = { name: draft.name };
      for (const f of FIELDS[selection.kind]) fields[f] = Number(draft[f]);
      if (selection.kind === "areas") fields.purpose = draft.purpose;
      if (selection.kind === "workstations") fields.activity = draft.activity;
      if (selection.kind === "workstations" && draft.facing && world?.facings) fields.facing = draft.facing;
      if (selection.id === null && selection.kind === "areas") fields.buildingId = selection.parentId;
      if (selection.id === null && selection.kind === "workstations") fields.areaId = selection.parentId;
      const result = await saveWorldItem(selection.kind, selection.id, fields);
      await load();
      setSelection({ kind: selection.kind, id: String(result.saved.id) });
      setNotice("Saved.");
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function setActive(activeNow: boolean) {
    if (!selection || selection.id === null) return;
    setBusy(true);
    setSaveError(null);
    try {
      await saveWorldItem(selection.kind, selection.id, { active: activeNow });
      await load();
      setNotice(activeNow ? "Reactivated." : "Deactivated. Nothing was deleted.");
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    setSaveError(null);
    try {
      await createWorld();
      await load();
      setNotice("The world was created from the current keep.");
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function applyTemplate(id: string, name: string) {
    if (!window.confirm(`Replace the current world with "${name}"? The current world is kept (retired), not deleted. Agents, their work and history are unchanged.`)) return;
    setBusy(true);
    setSaveError(null);
    try {
      await applyWorldTemplate(id);
      setSelection(null);
      await load();
      setNotice(`The world is now "${name}".`);
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (loadError && !world)
    return <StateNotice role="alert" message="Couldn't load the world." detail={loadError} action={<PixelButton onClick={() => void load()}>Retry</PixelButton>} />;
  if (!view)
    return (
      <StateNotice
        role="status"
        message={
          <>
            Loading the world <Skeleton />
          </>
        }
      />
    );

  const isSelected = (kind: WorldKind, id: string) => selection?.kind === kind && selection.id === id;
  const rowClass = (kind: WorldKind, id: string, active: boolean) => cx(st.row, isSelected(kind, id) && st.rowSelected, !active && st.inactive);

  return (
    <>
      <section className={cx(px.board, st.world)} aria-label="World">
        <header className={st.header}>
          <h1 className={px.heading}>World</h1>
          <p className={px.detail}>
            Where your agents live and where their real work is drawn. Space only: moving a room or desk changes no agent&apos;s keys, budgets, approvals or progression.
          </p>
          {!saved ? (
            <StateNotice
              message="No world is saved yet. The map shows the current keep as a preview."
              action={
                <PixelButton kind="approve" onClick={() => void create()} disabled={busy}>
                  Create the world from the current keep
                </PixelButton>
              }
            />
          ) : (
            <form
              className={st.inline}
              onSubmit={(e) => {
                e.preventDefault();
                setBusy(true);
                void renameWorkspace(workspaceName)
                  .then(load)
                  .then(() => setNotice("Renamed."))
                  .catch((err) => setSaveError(errorText(err)))
                  .finally(() => setBusy(false));
              }}
            >
              <label className={st.field}>
                <span className={px.label}>Workspace name</span>
                <input className={px.input} value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} maxLength={60} disabled={busy} />
              </label>
              <PixelButton type="submit" disabled={busy || !workspaceName.trim()}>
                Rename
              </PixelButton>
            </form>
          )}
          {saved && world!.templates && world!.templates.length > 0 && (
            <div className={st.inline} role="group" aria-label="World templates">
              <span className={px.label}>Templates</span>
              {world!.templates.map((t) => (
                <PixelButton key={t.id} onClick={() => void applyTemplate(t.id, t.name)} disabled={busy} title={t.description} aria-pressed={world!.workspace?.template === t.id} className={world!.workspace?.template === t.id ? px.selected : undefined}>
                  {t.name}
                </PixelButton>
              ))}
            </div>
          )}
          {notice && <p role="status">{notice}</p>}
          {saveError && (
            <p role="alert" className={st.error}>
              {saveError}
            </p>
          )}
        </header>

        <div className={st.body}>
          <div
            className={st.map}
            style={{
              width: KEEP.width * MAP_SCALE,
              height: KEEP.height * MAP_SCALE,
            }}
            role="img"
            aria-label="World map preview"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={KEEP.src} width={KEEP.width * MAP_SCALE} height={KEEP.height * MAP_SCALE} alt="" className={st.mapImage} draggable={false} />
            {view.areas.map((a) => (
              <button
                key={a.id}
                type="button"
                className={cx(st.mapArea, isSelected("areas", a.id) && st.mapSelected, !a.active && st.inactive)}
                data-purpose={a.purpose}
                style={{
                  left: a.x * MAP_SCALE,
                  top: a.y * MAP_SCALE,
                  width: a.w * MAP_SCALE,
                  height: a.h * MAP_SCALE,
                }}
                onClick={() => saved && select({ kind: "areas", id: a.id })}
                title={`${a.name} (${a.purpose})`}
                aria-label={`Area ${a.name}`}
                tabIndex={-1}
              />
            ))}
            {view.workstations.map((w) => (
              <span
                key={w.id}
                className={cx(st.mapStation, !w.active && st.inactive)}
                style={{ left: w.x * MAP_SCALE, top: w.y * MAP_SCALE }}
                title={`${w.name} (${w.activity})`}
              />
            ))}
          </div>

          <div className={st.lists}>
            {view.buildings.map((b) => (
              <div key={b.id} className={st.group}>
                <div className={st.groupHead}>
                  <button type="button" className={rowClass("buildings", b.id, b.active)} onClick={() => saved && select({ kind: "buildings", id: b.id })} disabled={!saved}>
                    <span className={px.label}>{b.name}</span>
                    <span className={px.dim}>building{b.active ? "" : " · inactive"}</span>
                  </button>
                  {saved && (
                    <PixelButton onClick={() => select({ kind: "areas", id: null, parentId: b.id })} disabled={busy}>
                      Add area
                    </PixelButton>
                  )}
                </div>
                <ul className={st.items}>
                  {view.areas
                    .filter((a) => a.buildingId === b.id)
                    .map((a) => (
                      <li key={a.id}>
                        <div className={st.groupHead}>
                          <button type="button" className={rowClass("areas", a.id, a.active)} onClick={() => saved && select({ kind: "areas", id: a.id })} disabled={!saved}>
                            <span>{a.name}</span>
                            <span className={st.purpose} data-purpose={a.purpose}>
                              {a.purpose}
                            </span>
                            {!a.active && <span className={px.dim}>inactive</span>}
                          </button>
                          {saved && a.purpose === "work" && (
                            <PixelButton
                              onClick={() =>
                                select({
                                  kind: "workstations",
                                  id: null,
                                  parentId: a.id,
                                })
                              }
                              disabled={busy}
                            >
                              Add workstation
                            </PixelButton>
                          )}
                        </div>
                        <ul className={st.items}>
                          {view.workstations
                            .filter((w) => w.areaId === a.id)
                            .map((w) => (
                              <li key={w.id}>
                                <button
                                  type="button"
                                  className={rowClass("workstations", w.id, w.active)}
                                  onClick={() => saved && select({ kind: "workstations", id: w.id })}
                                  disabled={!saved}
                                >
                                  <span>{w.name}</span>
                                  <span className={px.dim}>
                                    workstation · {w.activity}
                                    {w.active ? "" : " · inactive"}
                                  </span>
                                </button>
                              </li>
                            ))}
                        </ul>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
            {saved && (
              <PixelButton onClick={() => select({ kind: "buildings", id: null, parentId: null })} disabled={busy}>
                Add building
              </PixelButton>
            )}
          </div>

          {selection && (
            <form className={cx(px.parchment, st.editor)} onSubmit={save} aria-label="Edit world item">
              <div className={px.label}>
                {selection.id === null ? "New " : ""}
                {selection.kind === "buildings" ? "building" : selection.kind === "areas" ? "area" : "workstation"}
              </div>
              <label className={st.field}>
                <span>Name</span>
                <input className={px.input} value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={60} disabled={busy} />
              </label>
              {selection.kind === "areas" && (
                <label className={st.field}>
                  <span>Purpose</span>
                  <select className={px.input} value={draft.purpose} onChange={(e) => setDraft({ ...draft, purpose: e.target.value })} disabled={busy}>
                    {world!.purposes.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {selection.kind === "workstations" && (
                <label className={st.field}>
                  <span>Activity it hosts</span>
                  <select className={px.input} value={draft.activity} onChange={(e) => setDraft({ ...draft, activity: e.target.value })} disabled={busy}>
                    {world!.activities.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {selection.kind === "workstations" && world!.facings && (
                <label className={st.field}>
                  <span>Agent faces</span>
                  <select className={px.input} value={draft.facing ?? "up"} onChange={(e) => setDraft({ ...draft, facing: e.target.value })} disabled={busy}>
                    {world!.facings.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className={st.numbers}>
                {FIELDS[selection.kind].map((f) => (
                  <label key={f} className={st.field}>
                    <span>{f}</span>
                    <input className={px.input} type="number" step={1} value={draft[f] ?? ""} onChange={(e) => setDraft({ ...draft, [f]: e.target.value })} disabled={busy} />
                  </label>
                ))}
              </div>
              <p className={px.detail}>World pixels on the 1440 × 1024 keep. {selection.kind === "workstations" ? "x, y is where the agent stands to work." : ""}</p>
              <div className={st.actions}>
                <PixelButton type="submit" kind="approve" disabled={busy || !(draft.name ?? "").trim()}>
                  {selection.id === null ? "Add" : "Save"}
                </PixelButton>
                {selectedItem && (
                  <PixelButton onClick={() => void setActive(!(selectedItem.active as boolean))} disabled={busy}>
                    {selectedItem.active ? "Deactivate" : "Reactivate"}
                  </PixelButton>
                )}
                <PixelButton onClick={() => select(null)} disabled={busy}>
                  Close
                </PixelButton>
              </div>
            </form>
          )}
        </div>
      </section>
    </>
  );
}
