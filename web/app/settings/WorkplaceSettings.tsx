"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createRoom, getRoleIcons, getWorkplaceSettings, getWorld, saveAgentHours, saveWorkplaceSettings, setAgentRoleIcon, updateRoom, type RoleIconCatalogue, type RoleIconEntry, type WorkplaceRoom, type WorkplaceSettings, type WorkplaceSettingsData } from "../../lib/api";
import { PixelButton, Skeleton, StateNotice, cx, px } from "../../components/pixel/Pixel";
import { errorText } from "../../lib/keep";
import { WEEKDAY_NAMES, minutesLabel } from "../../lib/keepTime";
import { AgentLabel, RoleIcon, useRoleIcons } from "../../components/agents/RoleIcon";
import st from "./settings.module.css";

const refusal = (err: unknown) => errorText(err).replace(/^API request failed: \S+ \S+ -> \d+ [^:]*: /, "");
const toMinutes = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["Europe/London", "UTC"];
  } catch {
    return ["Europe/London", "UTC"];
  }
})();

/** Reads the workplace settings once and saves a change through the API (every rule is the backend's). */
function useWorkplace() {
  const [data, setData] = useState<WorkplaceSettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await getWorkplaceSettings());
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (work: () => Promise<unknown>, done: string) => {
    setNotice(null);
    try {
      await work();
      setNotice(done);
      await load();
    } catch (err) {
      setNotice(`Not saved: ${refusal(err)}`);
    }
  };
  return { data, error, notice, run, load };
}

function Loading({ error, retry }: { error: string | null; retry: () => void }) {
  return error ? <StateNotice role="alert" message="Couldn't read the workplace settings." detail={error} action={<PixelButton onClick={retry}>Retry</PixelButton>} /> : <Skeleton />;
}

/** General → the Keep's clock and meeting defaults. Saved for everyone. */
export function WorkplaceClockSettings() {
  const { data, error, notice, run, load } = useWorkplace();
  const [draft, setDraft] = useState<WorkplaceSettings | null>(null);
  useEffect(() => {
    if (data) setDraft(data.settings);
  }, [data]);
  if (!data || !draft) return <Loading error={error} retry={() => void load()} />;
  const set = (patch: Partial<WorkplaceSettings>) => setDraft({ ...draft, ...patch });
  const save = (e: FormEvent) => {
    e.preventDefault();
    const { timezone, workStartMinute, workEndMinute, workingDays, outsideWorkingHours, defaultMeetingMinutes, reminderMinutes, gatherMinutes } = draft;
    void run(() => saveWorkplaceSettings({ timezone, workStartMinute, workEndMinute, workingDays, outsideWorkingHours, defaultMeetingMinutes, reminderMinutes, gatherMinutes }), "Saved for everyone.");
  };
  return (
    <form className={st.field} onSubmit={save} aria-label="The Keep's clock" data-testid="workplace-clock">
      <h2 className={px.heading}>The Keep&apos;s clock (saved for everyone)</h2>
      <p className={px.detail}>Every meeting time is kept in this timezone, whatever this browser&apos;s own clock says.</p>
      <label className={st.field}>
        <span className={px.label}>Timezone</span>
        <select className={px.input} value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })}>
          {(ZONES.includes(draft.timezone) ? ZONES : [draft.timezone, ...ZONES]).map((z) => (
            <option key={z}>{z}</option>
          ))}
        </select>
      </label>
      <div className={st.inline}>
        <label className={st.field}>
          <span className={px.label}>Working hours from</span>
          <input className={px.input} type="time" value={minutesLabel(draft.workStartMinute)} onChange={(e) => set({ workStartMinute: toMinutes(e.target.value) })} />
        </label>
        <label className={st.field}>
          <span className={px.label}>to</span>
          <input className={px.input} type="time" value={minutesLabel(Math.min(draft.workEndMinute, 1439))} onChange={(e) => set({ workEndMinute: toMinutes(e.target.value) })} />
        </label>
      </div>
      <fieldset className={st.inline}>
        <legend className={px.label}>Working days</legend>
        {WEEKDAY_NAMES.map((d, i) => (
          <label key={d} className={st.check}>
            <input type="checkbox" checked={draft.workingDays.includes(i + 1)} onChange={(e) => set({ workingDays: e.target.checked ? [...draft.workingDays, i + 1].sort() : draft.workingDays.filter((x) => x !== i + 1) })} /> {d}
          </label>
        ))}
      </fieldset>
      <label className={st.field}>
        <span className={px.label}>Meetings outside working hours</span>
        <select className={px.input} value={draft.outsideWorkingHours} onChange={(e) => set({ outsideWorkingHours: e.target.value as "forbid" | "allow" })}>
          <option value="forbid">not allowed</option>
          <option value="allow">allowed</option>
        </select>
      </label>
      <label className={st.field}>
        <span className={px.label}>Work outside working hours</span>
        <select className={px.input} value={draft.workOutsideHours} onChange={(e) => set({ workOutsideHours: e.target.value as "forbid" | "allow" })}>
          <option value="allow">allowed</option>
          <option value="forbid">not allowed</option>
        </select>
        <span className={px.hint}>
          Not allowed: the Manager will not give an agent NEW work outside its hours. Work already running is never interrupted, and this is not an emergency stop.
        </span>
      </label>
      <div className={st.inline}>
        <label className={st.field}>
          <span className={px.label}>Default meeting (minutes)</span>
          <input className={px.input} type="number" min={5} max={480} step={5} value={draft.defaultMeetingMinutes} onChange={(e) => set({ defaultMeetingMinutes: Number(e.target.value) })} />
        </label>
        <label className={st.field}>
          <span className={px.label}>Reminder before (minutes)</span>
          <input className={px.input} type="number" min={0} max={1440} value={draft.reminderMinutes} onChange={(e) => set({ reminderMinutes: Number(e.target.value) })} />
        </label>
        <label className={st.field}>
          <span className={px.label}>Leave for the room (minutes before)</span>
          <input className={px.input} type="number" min={0} max={60} value={draft.gatherMinutes} onChange={(e) => set({ gatherMinutes: Number(e.target.value) })} />
        </label>
      </div>
      <PixelButton type="submit" kind="approve">
        Save the clock
      </PixelButton>
      {notice && <p role="status">{notice}</p>}
    </form>
  );
}

/** Workplace → meeting rooms: capacity, purpose, where each is on the map, in use or not. Never deleted. */
export function WorkplaceRooms() {
  const { data, error, notice, run, load } = useWorkplace();
  const [areas, setAreas] = useState<string[]>([]);
  const [fresh, setFresh] = useState({ name: "", purpose: "conference", capacity: 6, locationAreaName: "" });
  useEffect(() => {
    getWorld()
      .then((w) => setAreas([...new Set((w.workspace ? w.areas : (w.preview?.areas ?? [])).filter((a) => a.active).map((a) => a.name))].sort()))
      .catch(() => setAreas([]));
  }, []);
  if (!data) return <Loading error={error} retry={() => void load()} />;
  const areaOptions = (current: string | null) => (current && !areas.includes(current) ? [current, ...areas] : areas);
  return (
    <div className={st.field} data-testid="workplace-rooms">
      <p className={px.detail}>
        A room seats its capacity and is drawn on the map area it names. Two meetings never share a room at the same time; the Keep checks that, not this page. A room
        that is not in use keeps its past meetings and takes no new ones.
      </p>
      <table className={st.table}>
        <thead>
          <tr>
            <th>Room</th>
            <th>Purpose</th>
            <th>Seats</th>
            <th>On the map</th>
            <th>In use</th>
          </tr>
        </thead>
        <tbody>
          {data.rooms.map((r: WorkplaceRoom) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>
                <select className={px.input} value={r.purpose} aria-label={`${r.name} purpose`} onChange={(e) => void run(() => updateRoom(r.id, { purpose: e.target.value }), `${r.name} saved.`)}>
                  {data.allowed.roomPurposes.map((p) => (
                    <option key={p} value={p}>
                      {p.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  className={cx(px.input, st.narrow)}
                  type="number"
                  min={1}
                  max={100}
                  defaultValue={r.capacity}
                  aria-label={`${r.name} seats`}
                  onBlur={(e) => Number(e.target.value) !== r.capacity && void run(() => updateRoom(r.id, { capacity: Number(e.target.value) }), `${r.name} saved.`)}
                />
              </td>
              <td>
                <select className={px.input} value={r.locationAreaName ?? ""} aria-label={`${r.name} location`} onChange={(e) => void run(() => updateRoom(r.id, { locationAreaName: e.target.value || null }), `${r.name} saved.`)}>
                  <option value="">not on the map</option>
                  {areaOptions(r.locationAreaName).map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
              </td>
              <td>
                <input type="checkbox" checked={r.active} aria-label={`${r.name} in use`} onChange={(e) => void run(() => updateRoom(r.id, { active: e.target.checked }), `${r.name} saved.`)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className={st.inline}
        aria-label="Add a room"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => createRoom({ name: fresh.name.trim(), purpose: fresh.purpose, capacity: fresh.capacity, locationAreaName: fresh.locationAreaName || null, active: true }), "Room added.");
        }}
      >
        <input className={px.input} value={fresh.name} onChange={(e) => setFresh({ ...fresh, name: e.target.value })} placeholder="New room" maxLength={60} aria-label="New room name" />
        <select className={px.input} value={fresh.purpose} onChange={(e) => setFresh({ ...fresh, purpose: e.target.value })} aria-label="New room purpose">
          {data.allowed.roomPurposes.map((p) => (
            <option key={p} value={p}>
              {p.replace("_", " ")}
            </option>
          ))}
        </select>
        <input className={cx(px.input, st.narrow)} type="number" min={1} max={100} value={fresh.capacity} onChange={(e) => setFresh({ ...fresh, capacity: Number(e.target.value) })} aria-label="New room seats" />
        <select className={px.input} value={fresh.locationAreaName} onChange={(e) => setFresh({ ...fresh, locationAreaName: e.target.value })} aria-label="New room location">
          <option value="">not on the map</option>
          {areas.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <PixelButton type="submit" disabled={!fresh.name.trim()}>
          Add room
        </PixelButton>
      </form>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

/** Agents → each agent's own working hours (blank = the Keep's). */
export function AgentHoursSettings({ agents }: { agents: string[] }) {
  const { data, error, notice, run, load } = useWorkplace();
  if (!data) return <Loading error={error} retry={() => void load()} />;
  const keep = data.settings;
  return (
    <div className={st.field} data-testid="agent-hours">
      <h2 className={px.heading}>Working hours (saved for everyone)</h2>
      <p className={px.detail}>
        An agent is never booked into a meeting outside its working hours when the Keep forbids it. Blank uses the Keep&apos;s {minutesLabel(keep.workStartMinute)}–{minutesLabel(keep.workEndMinute)}.
      </p>
      <table className={st.table}>
        <tbody>
          {agents.map((name) => {
            const own = data.agentHours.find((h) => h.agentName === name);
            return (
              <tr key={name}>
                <td>
                  <AgentLabel name={name} />
                </td>
                <td>
                  <input
                    className={px.input}
                    type="time"
                    aria-label={`${name} from`}
                    defaultValue={own?.workStartMinute != null ? minutesLabel(own.workStartMinute) : ""}
                    onBlur={(e) => {
                      const end = (e.currentTarget.closest("tr")?.querySelector("input[data-end]") as HTMLInputElement | null)?.value ?? "";
                      if (!e.target.value && !end) return void run(() => saveAgentHours(name, { workStartMinute: null, workEndMinute: null, workingDays: null }), `${name} uses the Keep's hours.`);
                      if (e.target.value && end) void run(() => saveAgentHours(name, { workStartMinute: toMinutes(e.target.value), workEndMinute: toMinutes(end), workingDays: own?.workingDays ?? null }), `${name} saved.`);
                    }}
                  />
                </td>
                <td>
                  <input
                    className={px.input}
                    type="time"
                    data-end
                    aria-label={`${name} to`}
                    defaultValue={own?.workEndMinute != null ? minutesLabel(own.workEndMinute) : ""}
                    onBlur={(e) => {
                      const start = (e.currentTarget.closest("tr")?.querySelector("input:not([data-end])") as HTMLInputElement | null)?.value ?? "";
                      if (start && e.target.value) void run(() => saveAgentHours(name, { workStartMinute: toMinutes(start), workEndMinute: toMinutes(e.target.value), workingDays: own?.workingDays ?? null }), `${name} saved.`);
                    }}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

/** Notifications → which internal notices are written. Internal records only; no outside channel exists. */
export function NotificationSettings() {
  const { data, error, notice, run, load } = useWorkplace();
  if (!data) return <Loading error={error} retry={() => void load()} />;
  const toggle = (key: "notifyInvitations" | "notifyReminders" | "notifyAnnouncements", label: string, detail: string) => (
    <label className={st.check} key={key}>
      <input type="checkbox" checked={data.settings[key]} onChange={(e) => void run(() => saveWorkplaceSettings({ [key]: e.target.checked }), "Saved for everyone.")} />
      <span>
        <span className={px.label}>{label}</span> <span className={px.detail}>{detail}</span>
      </span>
    </label>
  );
  return (
    <div className={st.field} data-testid="notification-settings">
      <p className={px.detail}>Notifications are internal Command Keep records. Nothing is emailed or posted anywhere; a moved or cancelled meeting always tells its participants.</p>
      {toggle("notifyInvitations", "Meeting invitations", "when a meeting is scheduled")}
      {toggle("notifyReminders", "Meeting reminders", `delivered ${data.settings.reminderMinutes} minutes before (General)`)}
      {toggle("notifyAnnouncements", "Announcements", "operator announcements to every agent")}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

/**
 * Agents → role icons: which catalogue symbol stands beside each agent's name. Identity only — an icon
 * grants nothing and implies no capability, and an agent keeps it across new versions. Left alone, an
 * agent shows the icon its first version's own words earn.
 */
export function RoleIconSettings() {
  const [data, setData] = useState<{ catalogue: RoleIconCatalogue; agents: RoleIconEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await getRoleIcons());
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!data) return <Loading error={error} retry={() => void load()} />;
  return (
    <div className={st.field} data-testid="role-icons">
      <h2 className={px.heading}>Role icons (saved for everyone)</h2>
      <p className={px.detail}>
        The small symbol beside an agent&apos;s name says which role it plays. It is identity, not authority: it grants nothing, implies no capability, and never changes
        when the agent gets a new version. What an agent may do is set only by its Grants.
      </p>
      <table className={st.table}>
        <tbody>
          {data.agents.map((a) => (
            <tr key={a.name}>
              <td>
                <AgentLabel name={a.name} />
              </td>
              <td>
                <select
                  className={px.input}
                  value={a.iconId}
                  aria-label={`${a.name} role icon`}
                  onChange={(e) => {
                    setNotice(null);
                    void setAgentRoleIcon(a.name, e.target.value)
                      .then(() => {
                        setNotice(`${a.name} saved. Reload to see it everywhere.`);
                        return load();
                      })
                      .catch((err) => setNotice(`Not saved: ${refusal(err)}`));
                  }}
                >
                  {data.catalogue.icons.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} — {i.description}
                    </option>
                  ))}
                </select>
              </td>
              <td className={px.dim}>{a.chosen ? "chosen" : "from its role"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
