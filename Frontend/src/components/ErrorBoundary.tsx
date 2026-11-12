import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a render-time exception in a page and shows it, instead of letting
 * React unmount the tree and leave a white screen.
 *
 * This exists because of a real incident: Admin -> SAP Data Upload read
 * `cfg.storage.basePath` while rendering, and a save that returned a config
 * without `storage` threw a TypeError. With no boundary anywhere in the app the
 * entire dashboard vanished, so the visible symptom ("the screen goes blank")
 * said nothing about the cause and the only clue was the browser console.
 *
 * A page is the right granularity: the header and sidebar stay usable, so the
 * user can navigate away rather than reload and lose their place. `resetKey`
 * clears the error when the tab changes, which is what makes that work.
 */
interface Props {
  children: ReactNode;
  /** Changing this discards a caught error — pass the current tab. */
  resetKey?: string;
}

interface State {
  error: Error | null;
  /** Kept so the reset-on-navigation comparison happens during render. */
  key: string | undefined;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, key: undefined };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (state.error && state.key !== props.resetKey) return { error: null, key: props.resetKey };
    if (state.key !== props.resetKey) return { key: props.resetKey };
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console, not the notification API: this is a client-side defect for a
    // developer to read, and a failing page must not also fail to report.
    console.error('Page render failed:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="panel">
        <h2>This page could not be displayed</h2>
        <p className="note">
          <span className="bs spdel">error</span> The page stopped while drawing, so it has been
          replaced by this message — the rest of the dashboard still works. Pick another page from
          the menu, or reload to try again.
        </p>
        <p className="muted" style={{ marginTop: 12 }}>
          Please report this text:
        </p>
        <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {error.message || String(error)}
        </pre>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
