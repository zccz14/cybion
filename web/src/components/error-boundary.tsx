import { Component, type ErrorInfo, type ReactNode } from "react"
import { CircleAlertIcon, RefreshCwIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export type ErrorBoundaryFallbackProps = {
  error: Error
  reset: () => void
}

type ErrorBoundaryProps = {
  children: ReactNode
  fallback: (props: ErrorBoundaryFallbackProps) => ReactNode
  resetKeys?: readonly unknown[]
  onError?: (error: Error, info: ErrorInfo) => void
}

type ErrorBoundaryState = {
  error: Error | null
}

function normalizeError(value: unknown) {
  if (value instanceof Error) return value
  if (typeof value === "string") return new Error(value)

  try {
    const serialized = JSON.stringify(value)
    return new Error(serialized || "Unknown UI error")
  } catch {
    return new Error("Unknown UI error")
  }
}

function resetKeysChanged(previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined) {
  if (previous === next) return false
  if (!previous || !next || previous.length !== next.length) return true
  return next.some((value, index) => !Object.is(value, previous[index]))
}

/**
 * A render boundary for UI surfaces. Route changes can reset a failed surface
 * without tearing down the authenticated application shell.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: normalizeError(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info)
    console.error("Cybion UI error boundary caught an error", error, info)
  }

  componentDidUpdate(previousProps: ErrorBoundaryProps) {
    if (
      this.state.error &&
      resetKeysChanged(previousProps.resetKeys, this.props.resetKeys)
    ) {
      this.reset()
    }
  }

  private reset = () => {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      return this.props.fallback({ error: this.state.error, reset: this.reset })
    }

    return this.props.children
  }
}

type ErrorBoundaryFallbackViewProps = ErrorBoundaryFallbackProps & {
  title: string
  description: string
  detailsLabel: string
  retryLabel: string
  reloadLabel: string
}

export function ErrorBoundaryFallback({
  error,
  reset,
  title,
  description,
  detailsLabel,
  retryLabel,
  reloadLabel,
}: ErrorBoundaryFallbackViewProps) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card role="alert" className="w-full max-w-xl">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription className="break-words">{error.message}</AlertDescription>
          </Alert>
          <details className="rounded-md border p-3 text-sm">
            <summary className="cursor-pointer font-medium">{detailsLabel}</summary>
            <p className="mt-2 break-words font-mono text-xs text-muted-foreground">{error.stack ?? error.message}</p>
          </details>
        </CardContent>
        <CardFooter className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => window.location.reload()}>
            <RefreshCwIcon data-icon="inline-start" />
            {reloadLabel}
          </Button>
          <Button onClick={reset}>{retryLabel}</Button>
        </CardFooter>
      </Card>
    </div>
  )
}
