"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { getRegistry, setAgentAppearance, type Appearance, type RegistryData } from "../../lib/api";
import { errorText } from "../../lib/keep";
import { PixelButton, Skeleton, StateNotice, cx, px } from "../pixel/Pixel";
import { CharacterStation, appearanceFrom } from "./CharacterStation";
import b from "./builder.module.css";

/**
 * Change appearance (R2 visual identity): one explicit save of how a persistent agent looks,
 * for every version at once. The only write is `POST /agent-appearances/:name`, which records
 * no Definition version, Grant or event.
 */
export function AppearanceEditor({ id }: { id: string }) {
  const [registry, setRegistry] = useState<RegistryData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    getRegistry()
      .then(setRegistry)
      .catch((err) => setLoadError(errorText(err)));
  }, []);

  if (loadError) return <StateNotice role="alert" message="Couldn't load the Registry, so the appearance can't be changed." detail={loadError} />;
  if (!registry) return <StateNotice role="status" message={<>Loading the Registry <Skeleton /></>} />;
  const def = registry.agentDefinitions.find((d) => d.id === id);
  if (!def) return <StateNotice role="alert" message="That agent isn't in the Registry." detail={`agent definition ${id}`} />;
  if (!registry.builder?.appearance) return <StateNotice role="alert" message="This API build doesn't offer appearances." detail="GET /registry returned no appearance options." />;
  return <Editor def={def} options={registry.builder.appearance} />;
}

function Editor({ def, options }: { def: RegistryData["agentDefinitions"][number]; options: NonNullable<NonNullable<RegistryData["builder"]>["appearance"]> }) {
  const [value, setValue] = useState<Appearance>(() => appearanceFrom(options, def.appearance ?? def.look));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await setAgentAppearance(def.name, value);
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={b.form} onSubmit={submit} aria-label="Change appearance">
      <header className={b.header}>
        <h1 className={px.heading}>{def.name}&apos;s appearance</h1>
        <p className={px.detail}>
          {def.appearance ? "" : `${def.name} has the default character until you save one. `}
          Saving changes how {def.name} looks in every version. It creates no new version and changes no key, budget or run.
        </p>
      </header>
      <CharacterStation
        options={options}
        value={value}
        onChange={(next) => {
          setValue(next);
          setSaved(false);
        }}
        disabled={saving}
      />
      <div className={b.actions}>
        <PixelButton type="submit" kind="approve" disabled={saving}>
          Save appearance
        </PixelButton>
        <Link href={`/agents/${def.id}`} className={cx(b.labelLink, px.label)}>
          Back to {def.name} v{def.version}
        </Link>
        {saving && (
          <span role="status">
            Saving <Skeleton />
          </span>
        )}
        {saved && <span role="status">Saved. No version was created.</span>}
      </div>
      {error && (
        <div role="alert" className={b.error}>
          <p className={b.errorMessage}>The appearance wasn&apos;t saved.</p>
          <p className={px.detail}>{error}</p>
        </div>
      )}
    </form>
  );
}
