import { Component, type CSSProperties, type ReactNode } from "react"
import i18n from "../../../i18n"

// The app has no error boundaries, so any render error (e.g. an interaction in replay mode that the
// game UI wasn't built for) unmounts the whole React tree → blank page → refresh. This boundary
// contains such errors to the replay viewer: it shows a recoverable fallback instead of blanking,
// and "Resume" re-mounts the subtree (the playback clock in the ReplayRoom keeps running underneath).
interface State {
  error: Error | null
}

export default class ReplayErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error("[replay] contained render error:", error)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={S.wrap}>
          <div style={S.card}>
            <div style={S.title}>{i18n.t("replay.boundary_title")}</div>
            <div style={S.msg}>{this.state.error.message}</div>
            <div style={S.row}>
              <button style={S.btn} onClick={() => this.setState({ error: null })}>
                {i18n.t("replay.resume")}
              </button>
              <button style={S.btnGhost} onClick={() => window.location.reload()}>
                {i18n.t("replay.reload")}
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

const S: Record<string, CSSProperties> = {
  wrap: {
    position: "fixed",
    inset: 0,
    zIndex: 2000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(17,21,28,0.85)",
    color: "#dfe5ef",
    font: "14px/1.5 sans-serif"
  },
  card: {
    padding: "24px 28px",
    background: "rgba(28,33,45,0.97)",
    border: "1px solid #3a4358",
    borderRadius: 12,
    textAlign: "center",
    maxWidth: 460
  },
  title: { fontSize: 16, fontWeight: 700, marginBottom: 8 },
  msg: { opacity: 0.7, fontSize: 12, marginBottom: 16, wordBreak: "break-word" },
  row: { display: "flex", gap: 10, justifyContent: "center" },
  btn: {
    height: 32,
    padding: "0 16px",
    background: "#3b7ddd",
    border: "1px solid #3b7ddd",
    borderRadius: 6,
    color: "#fff",
    fontWeight: 600,
    cursor: "pointer"
  },
  btnGhost: {
    height: 32,
    padding: "0 16px",
    background: "#2b3346",
    border: "1px solid #3a4358",
    borderRadius: 6,
    color: "#dfe5ef",
    cursor: "pointer"
  }
}
