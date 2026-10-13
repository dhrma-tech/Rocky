import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Pebble } from "../agent-ui/Pebble.tsx";
import { onboarding, type Swatch } from "../api.ts";
import { SwatchPicker } from "../components/SwatchPicker.tsx";
import { Avatar, Button, ErrorState, Input, Skeleton, Tabs, useToast } from "../ui/index.tsx";
import "./screens.css";

const DEFAULT_NAME = "Rocky";
const DEFAULT_SWATCH: Swatch = "periwinkle";

/**
 * Profile (UI spec 19): You and Rocky. The one settings-like screen with an explicit Save, so the
 * pebble preview can be reviewed first. Built only from what the engine uses (D-057): your name
 * (the sidebar avatar), Rocky's name and colour. The time zone is this computer's, which routines
 * already follow.
 */
export function ProfilePage() {
  const qc = useQueryClient();
  const toast = useToast();
  const state = useQuery({ queryKey: ["onboarding"], queryFn: onboarding.get });
  const [tab, setTab] = useState("you");
  const [userName, setUserName] = useState("");
  const [name, setName] = useState(DEFAULT_NAME);
  const [swatch, setSwatch] = useState<Swatch>(DEFAULT_SWATCH);
  const saved = state.data;
  const reset = () => {
    if (!saved) return;
    setUserName(saved.userName ?? "");
    setName(saved.name);
    setSwatch(saved.swatch);
  };
  useEffect(reset, [saved]);

  const save = useMutation({
    mutationFn: () =>
      onboarding.save({
        userName: userName.trim() || null,
        name: name.trim() || DEFAULT_NAME,
        swatch,
      }),
    onSuccess: (v) => {
      qc.setQueryData(["onboarding"], v);
      toast({ text: "Profile saved." });
    },
  });

  const dirty =
    !!saved &&
    ((userName.trim() || null) !== saved.userName ||
      (name.trim() || DEFAULT_NAME) !== saved.name ||
      swatch !== saved.swatch);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sample = new Date().toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  if (state.isLoading)
    return (
      <div className="rk-page">
        <h1 className="rk-title">Profile</h1>
        <Skeleton rows={4} height={64} label="Loading your profile" />
      </div>
    );
  if (state.error)
    return (
      <div className="rk-page">
        <h1 className="rk-title">Profile</h1>
        <ErrorState
          title="Couldn't read your profile."
          happened={state.error.message}
          rockyDid="Nothing was changed."
          fix={
            <Button variant="primary" onClick={() => void state.refetch()}>
              Retry
            </Button>
          }
        />
      </div>
    );

  const shownName = name.trim() || DEFAULT_NAME;
  return (
    <div className="rk-page">
      <header className="rk-page__head">
        <h1 className="rk-title">Profile</h1>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Tabs
          label="Profile"
          value={tab}
          onChange={setTab}
          tabs={[
            {
              id: "you",
              title: "You",
              panel: (
                <div className="rk-profile">
                  <div className="rk-profile__preview">
                    <Avatar name={userName.trim() || "You"} size={64} />
                    <strong>{userName.trim() || "You"}</strong>
                  </div>
                  <Input
                    label="Your name"
                    help="Shown on your avatar in the sidebar."
                    value={userName}
                    maxLength={60}
                    autoComplete="name"
                    onChange={(e) => setUserName(e.target.value)}
                  />
                  <div>
                    <p className="rk-field__label" style={{ margin: 0 }}>
                      Time zone
                    </p>
                    <p style={{ margin: 0 }}>
                      {zone} <span className="rk-muted">· now {sample}</span>
                    </p>
                    <p className="rk-small rk-muted" style={{ margin: 0 }}>
                      Rocky uses this computer's time zone. Routines run on its clock.
                    </p>
                  </div>
                  <p className="rk-small" style={{ margin: 0 }}>
                    Facts about you that Rocky uses live in{" "}
                    <Link to="/memory" style={{ textDecoration: "underline" }}>
                      Memory › About you
                    </Link>
                    .
                  </p>
                </div>
              ),
            },
            {
              id: "rocky",
              title: shownName,
              panel: (
                <div className="rk-profile">
                  <div className="rk-profile__preview">
                    <Pebble size={64} swatch={swatch} label={`${shownName}, in ${swatch}`} />
                    <strong>{shownName}</strong>
                  </div>
                  <Input
                    label="Name"
                    value={name}
                    maxLength={40}
                    autoComplete="off"
                    onChange={(e) => setName(e.target.value)}
                  />
                  <SwatchPicker value={swatch} onChange={setSwatch} />
                  <p className="rk-small rk-muted" style={{ margin: 0 }}>
                    The colour is only decoration. Rocky's state is always shown in words.
                  </p>
                  <div>
                    <Button
                      variant="tertiary"
                      onClick={() => {
                        setName(DEFAULT_NAME);
                        setSwatch(DEFAULT_SWATCH);
                      }}
                    >
                      Reset name and colour
                    </Button>
                  </div>
                </div>
              ),
            },
          ]}
        />
        {save.error && (
          <p role="alert" className="rk-small">
            Couldn't save: {save.error.message}. Your changes are still here.
          </p>
        )}
        <div className="rk-profile__actions">
          <Button variant="tertiary" disabled={!dirty} onClick={reset}>
            Discard changes
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={!dirty}
            loading={save.isPending && "Saving…"}
          >
            Save
          </Button>
        </div>
      </form>
    </div>
  );
}
