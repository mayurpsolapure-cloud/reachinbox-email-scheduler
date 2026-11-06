import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useEffect } from "react";
import { AlertCircle, Check, ChevronLeft, ChevronRight, LoaderCircle, SearchX } from "lucide-react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`button button-${variant} button-${size} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  return (
    <span className={`status-badge status-${normalized}`}>
      <span className="status-dot" />
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {action && <div className="page-header-action">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = "Loading your workspace…" }: { label?: string }) {
  return (
    <div className="loading-panel" role="status">
      <LoaderCircle className="spin" size={19} />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="state-card error-state" role="alert">
      <span className="state-icon"><AlertCircle size={19} /></span>
      <div>
        <strong>We couldn’t load this data</strong>
        <p>{message}</p>
        {onRetry && <Button size="sm" onClick={onRetry}>Try again</Button>}
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon ?? <SearchX size={20} />}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function Modal({
  title,
  description,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>×</button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function PaginationBar({
  pagination,
  onPageChange,
}: {
  pagination: { page: number; totalPages: number; total: number };
  onPageChange: (page: number) => void;
}) {
  const start = pagination.total === 0 ? 0 : (pagination.page - 1) * 20 + 1;
  const end = Math.min(pagination.page * 20, pagination.total);
  return (
    <div className="pagination">
      <span>Showing {start}–{end} of {pagination.total}</span>
      <div>
        <Button
          size="sm"
          aria-label="Previous page"
          disabled={pagination.page <= 1}
          onClick={() => onPageChange(pagination.page - 1)}
        >
          <ChevronLeft size={15} /> Previous
        </Button>
        <Button
          size="sm"
          aria-label="Next page"
          disabled={pagination.page >= pagination.totalPages}
          onClick={() => onPageChange(pagination.page + 1)}
        >
          Next <ChevronRight size={15} />
        </Button>
      </div>
    </div>
  );
}

export function ToastViewport({
  toasts,
}: {
  toasts: { id: number; message: string; tone: "success" | "error" }[];
}) {
  return (
    <div className="toast-viewport" aria-live="polite">
      {toasts.map((toast) => (
        <div className={`toast toast-${toast.tone}`} key={toast.id}>
          {toast.tone === "success" ? <Check size={17} /> : <AlertCircle size={17} />}
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
