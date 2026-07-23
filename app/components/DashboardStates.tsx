import styles from "../styles/dashboard.module.css";

interface InlineLoadingValueProps {
  label: string;
  width?: "small" | "large";
}

interface SectionErrorProps {
  heading: string;
  message: string;
  isRetrying: boolean;
  onRetry: () => void;
}

export function InlineLoadingValue({
  label,
  width = "small",
}: InlineLoadingValueProps) {
  return (
    <span aria-label={label} className={styles.loadingValue} role="status">
      <span
        aria-hidden="true"
        className={`${styles.inlineSkeleton} ${
          width === "large" ? styles.inlineSkeletonLarge : ""
        }`}
      />
    </span>
  );
}

export function SectionError({
  heading,
  message,
  isRetrying,
  onRetry,
}: SectionErrorProps) {
  return (
    <s-banner heading={heading} tone="critical">
      <s-stack gap="base">
        <s-paragraph>{message}</s-paragraph>
        <div>
          <s-button
            loading={isRetrying ? true : undefined}
            onClick={onRetry}
            variant="secondary"
          >
            Retry
          </s-button>
        </div>
      </s-stack>
    </s-banner>
  );
}
