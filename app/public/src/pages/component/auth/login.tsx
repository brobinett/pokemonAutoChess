// Replaced by pac-projects no-firebase patch.
// Profile switcher backed by localStorage via dev-auth shim.

import firebase from "firebase/compat/app"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router"
import { throttle } from "../../../../../utils/function"
import {
  type DevProfile,
  deleteProfile,
  listProfiles,
  setActiveProfile,
  upsertProfile
} from "../../../dev-auth"
import { joinLobbyRoom } from "../../../game/lobby-logic"
import { useAppDispatch, useAppSelector } from "../../../hooks"
import { logIn, logOut } from "../../../stores/NetworkStore"

import "./login.css"

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32)
}

export default function Login() {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const uid = useAppSelector((state) => state.network.uid)
  const displayName = useAppSelector((state) => state.network.displayName)
  const [profiles, setProfiles] = useState<DevProfile[]>([])
  const [newName, setNewName] = useState("")
  const [prejoining, setPrejoining] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  useEffect(() => {
    setProfiles(listProfiles())
    firebase.auth().onAuthStateChanged((u) => {
      if (u) dispatch(logIn(u))
    })
  }, [dispatch])

  const refreshProfiles = () => setProfiles(listProfiles())

  const preJoinLobby = throttle(async function prejoin() {
    setPrejoining(true)
    return joinLobbyRoom(dispatch, navigate)
      .then(() => navigate("/lobby"))
      .catch(() => setPrejoining(false))
  }, 1000)

  const createAndUse = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    const slug = slugify(trimmed)
    if (!slug) return
    upsertProfile(slug, trimmed)
    setActiveProfile(slug)
    setNewName("")
    refreshProfiles()
  }

  const selectProfile = (p: DevProfile) => {
    setActiveProfile(p.uid)
    refreshProfiles()
  }

  const removeProfile = (p: DevProfile) => {
    if (!confirm(`Delete dev profile "${p.displayName}"?`)) return
    deleteProfile(p.uid)
    refreshProfiles()
  }

  if (!uid) {
    return (
      <div id="play-panel">
        <div className="dev-auth-banner">
          <strong>Local dev mode</strong> — pick or create a profile. Each
          profile is a separate "user" stored in localStorage. Use the{" "}
          <code>?uid=name</code> URL param to pin a tab to a specific profile
          (useful for testing multiplayer).
        </div>

        {profiles.length > 0 && (
          <>
            <h3>Saved profiles</h3>
            <ul className="dev-auth-profiles">
              {profiles.map((p) => (
                <li key={p.uid}>
                  <button
                    className="bubbly blue"
                    onClick={() => selectProfile(p)}
                  >
                    {p.displayName}{" "}
                    <small style={{ opacity: 0.6 }}>({p.uid})</small>
                  </button>
                  <button
                    className="bubbly red"
                    onClick={() => removeProfile(p)}
                    title="Delete this profile"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <h3>{profiles.length === 0 ? "Create profile" : "New profile"}</h3>
        <div className="dev-auth-new">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createAndUse()
            }}
            placeholder="Display name"
            maxLength={32}
          />
          <button
            className="bubbly green"
            onClick={createAndUse}
            disabled={!newName.trim()}
          >
            Create &amp; use
          </button>
        </div>
      </div>
    )
  }

  return (
    <div id="play-panel">
      <p>
        {t("auth.authenticated_as")}: <strong>{displayName}</strong>{" "}
        <small style={{ opacity: 0.6 }}>({uid})</small>
      </p>
      <ul className="actions">
        <li>
          <button
            className="bubbly green"
            onClick={preJoinLobby}
            disabled={prejoining}
          >
            {prejoining ? t("auth.connecting") : t("auth.join_lobby")}
          </button>
        </li>
        <li>
          <button
            className="bubbly red"
            disabled={prejoining || loggingOut}
            onClick={async () => {
              setLoggingOut(true)
              try {
                await firebase.auth().signOut()
                dispatch(logOut())
              } finally {
                setLoggingOut(false)
              }
            }}
          >
            {loggingOut ? t("auth.signing_out") : "Switch profile"}
          </button>
        </li>
      </ul>
    </div>
  )
}
