import { Button, Result, Typography } from "antd";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

/**
 * Route-level React error boundary. Catches uncaught render errors so a crashing page shows a
 * fallback (retry / back home) instead of blanking the whole app — the top nav and Agent panel
 * (rendered by UserLayout, outside this boundary) stay interactive, so recovery doesn't require a
 * full page reload. "Retry" clears the error and re-renders (a deterministic crash re-triggers the
 * fallback); "Back home" navigates via the router.
 *
 * `resetKey` (the current location) clears a caught error on navigation — so routing away (or
 * clicking "back home", even to the same pathname with a different query) recovers without a
 * reload. Unlike a `key`-based remount, this only clears the error flag and does NOT unmount the
 * page subtree, so in-page query changes stay cheap.
 */
type Props = { children: ReactNode; resetKey: string };
type State = { error: Error | null; prevResetKey: string };

export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null, prevResetKey: this.props.resetKey };

    static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
        if (props.resetKey !== state.prevResetKey) return { error: null, prevResetKey: props.resetKey };
        return null;
    }

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("[ErrorBoundary] render crash:", error, info);
    }

    reset = () => this.setState({ error: null });

    render() {
        if (!this.state.error) return this.props.children;
        return <BoundaryFallback error={this.state.error} onReset={this.reset} />;
    }
}

/** ErrorBoundary scoped to the current router location: clears any caught error on navigation so
 *  the app recovers by routing away instead of needing a reload. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
    const location = useLocation();
    return (
        <ErrorBoundary resetKey={location.pathname + location.search}>
            {children}
        </ErrorBoundary>
    );
}

function BoundaryFallback({ error, onReset }: { error: Error; onReset: () => void }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    return (
        <div className="flex h-full w-full items-center justify-center p-6">
            <Result
                status="error"
                title={t("common.renderErrorTitle")}
                subTitle={t("common.renderErrorHint")}
                extra={[
                    <Button key="retry" type="primary" onClick={onReset}>
                        {t("common.retry")}
                    </Button>,
                    <Button key="home" onClick={() => navigate("/")}>
                        {t("common.backHome")}
                    </Button>,
                ]}
            >
                <Typography.Text type="danger" code className="block max-h-40 overflow-auto text-xs">
                    {String(error?.message || error)}
                </Typography.Text>
            </Result>
        </div>
    );
}

