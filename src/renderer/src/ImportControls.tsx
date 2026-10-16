import { useEffect, useRef, useState } from 'react'
import type { SelectedArea } from '../../shared/listings'
import type { Job } from '../../shared/desktop'

export default function ImportControls({
  area,
  onSettled,
}: {
  area: SelectedArea
  onSettled: () => void
}) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [error, setError] = useState('')
  const [workerError, setWorkerError] = useState('')
  const pendingAction = useRef<{ scope: string; key: string } | null>(null)
  const [creating, setCreating] = useState(false)
  const settled = useRef(onSettled)
  const previous = useRef('')
  useEffect(() => {
    settled.current = onSettled
  }, [onSettled])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const next = (await window.openAkiya.listImports({ state: 'active' }))
          .jobs
        if (!active) return
        const revision = JSON.stringify(
          next.map((job) => [
            job.id,
            job.state,
            job.counts.added + job.counts.updated + job.counts.unchanged,
          ]),
        )
        if (previous.current !== revision) {
          previous.current = revision
          settled.current()
        }
        setJobs(next)
        setWorkerError('')
      } catch {
        if (active)
          setWorkerError(
            'Import worker unavailable. Saved listings are retained. Quit and reopen to recover.',
          )
      }
      if (active) timer = setTimeout(refresh, 500)
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [])
  return (
    <section aria-label="Area imports" className="imports">
      <button
        disabled={creating}
        onClick={async () => {
          setCreating(true)
          setError('')
          const scope = JSON.stringify(area)
          if (pendingAction.current?.scope !== scope)
            pendingAction.current = { scope, key: crypto.randomUUID() }
          const idempotencyKey = pendingAction.current.key
          try {
            await window.openAkiya.createImportRequest({
              intent: 'import',
              area,
              idempotencyKey,
            })
            setJobs(
              (await window.openAkiya.listImports({ state: 'active' })).jobs,
            )
            // A fast import can finish between active-queue reads.
            previous.current = ''
            pendingAction.current = null
          } catch {
            setError(
              'Could not start import. Inspect the queue before retrying.',
            )
          } finally {
            setCreating(false)
          }
        }}
      >
        Import sample listings
      </button>
      <p>
        Closing the window keeps imports running. Reopen from the desktop
        launcher. Use Quit Open Akiya or Ctrl/Cmd+Q to exit.
      </p>
      {(error || workerError) && <p role="alert">{error || workerError}</p>}
      <ul aria-label="Import queue" aria-live="polite">
        {jobs.map((job) => (
          <li key={job.id}>
            <strong>
              {job.state === 'succeeded' ? 'Search finished' : job.state}
            </strong>{' '}
            · {job.area.center.latitude}, {job.area.center.longitude} ·{' '}
            {job.area.radiusKm} km ·{' '}
            {job.counts.added + job.counts.updated + job.counts.unchanged} saved
            ({job.counts.added} added, {job.counts.updated} updated)
            {job.error && <span> · {job.error.message}</span>}
            {(job.state === 'running' || job.state === 'queued') && (
              <button
                onClick={async () => {
                  try {
                    await window.openAkiya.cancelImport(job.id)
                    setJobs(
                      (await window.openAkiya.listImports({ state: 'active' }))
                        .jobs,
                    )
                    settled.current()
                  } catch {
                    setError(
                      'Could not cancel import. Inspect its current state before retrying.',
                    )
                  }
                }}
              >
                Cancel import
              </button>
            )}
          </li>
        ))}
      </ul>
      <p>
        Sample source only. Source coverage is unknown; finished imports do not
        establish real inventory.
      </p>
    </section>
  )
}
