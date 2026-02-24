import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
  message: string;
};

class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  public state: AppErrorBoundaryState = {
    hasError: false,
    message: "",
  };

  public static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
    };
  }

  public componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("App runtime error:", error, info);
  }

  private handleReload = () => {
    window.location.reload();
  };

  public render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-lg rounded-2xl border border-rose-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-rose-100 text-rose-600">
              <AlertTriangle className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
              <p className="mt-1 text-sm text-slate-600">
                A runtime error occurred. The page was recovered with a safe fallback instead of a blank screen.
              </p>
              <p className="mt-2 rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700">
                {this.state.message}
              </p>
            </div>
          </div>
          <div className="mt-5">
            <Button type="button" onClick={this.handleReload} className="bg-violet-600 text-white hover:bg-violet-500">
              Reload App
            </Button>
          </div>
        </div>
      </div>
    );
  }
}

export default AppErrorBoundary;
