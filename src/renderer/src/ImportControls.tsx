import { useEffect, useRef, useState } from 'react'
import type { SelectedArea } from '../../shared/listings'
import type { ImportRequest, Job } from '../../shared/desktop'

function isTerminal(state: Job['state']) {
  return state !== 'queued' && state !== 'running'
}

export default function ImportControls({
  area,
  onSettled,
}: {
  area: SelectedArea
  onSettled: () => void
}) {
  const [request, setRequest] = useState<ImportRequest | null>(null)
  const requests = useRef(new Map<string, ImportRequest>())
  const observedJobs = useRef(new Map<string, Job>())
  const [jobs, setJobs] = useState<Job[]>([])
  const [error, setError] = useState('')
  const [workerError, setWorkerError] = useState('')
  const pendingAction = useRef<{ scope: string; key: string } | null>(null)
  const [creating, setCreating] = useState(false)
  const settled = useRef(onSettled)
  const requestRef = useRef<string | null>(null)
  const previous = useRef('')
  useEffect(() => {
    settled.current = onSettled
  }, [onSettled])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const activeJobs = (
          await window.openAkiya.listImports({ state: 'active' })
        ).jobs
        for (const job of activeJobs) observedJobs.current.set(job.id, job)
        for (const [id, snapshot] of requests.current) {
          const nextRequest = await window.openAkiya.inspectImportRequest(id)
          if (!active) return
          requests.current.set(id, nextRequest)
          if (requestRef.current === id) setRequest(nextRequest)
          for (const jobId of nextRequest.jobIds) {
            const job = await window.openAkiya.inspectImport(jobId)
            if (!active) return
            observedJobs.current.set(job.id, job)
          }
          if (
            snapshot.state !== nextRequest.state &&
            isTerminal(nextRequest.state)
          )
            settled.current()
        }
        // Active jobs disappear from the queue at completion; inspect retained IDs.
        for (const [id, snapshot] of observedJobs.current) {
          if (
            !isTerminal(snapshot.state) &&
            !activeJobs.some((job) => job.id === id)
          ) {
            observedJobs.current.set(
              id,
              await window.openAkiya.inspectImport(id),
            )
          }
        }
        if (!active) return
        const next = [...observedJobs.current.values()]
        const revision = JSON.stringify(
          next.map((job) => [job.id, job.state, job.finishedAt]),
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
            const accepted = await window.openAkiya.createImportRequest({
              intent: 'import',
              area,
              idempotencyKey,
            })
            requests.current.set(accepted.id, accepted)
            requestRef.current = accepted.id
            setRequest(accepted)
            if (isTerminal(accepted.state)) settled.current()
            // A fast import can finish between active-queue reads.
            previous.current = ''
            pendingAction.current = null
          } catch (failure) {
            const code =
              failure && typeof failure === 'object' && 'code' in failure
                ? String(failure.code)
                : 'TRANSPORT_ERROR'
            setError(
              `Could not start import (${code}). Inspect the queue before retrying.`,
            )
          } finally {
            setCreating(false)
          }
        }}
      >
        Import sample listings
      </button>
      {request && (
        <p role="status">
          Request accepted · {request.disposition} · {request.state}
          {request.pendingFollowUp && ' · Follow-up pending'} · Request area:{' '}
          {request.area.center.latitude}, {request.area.center.longitude} ·{' '}
          {request.area.radiusKm} km
        </p>
      )}
      <p>
        Closing the window keeps imports running. Reopen from the desktop
        launcher. Use Quit Open Akiya or Ctrl/Cmd+Q to exit.
      </p>
      {(error || workerError) && <p role="alert">{error || workerError}</p>}
      <ul aria-label="Import queue" aria-live="polite">
        {jobs.map((job) => (
          <li key={job.id}>
            <strong>
              {job.state === 'succeeded'
                ? 'Search finished'
                : job.state === 'failed'
                  ? 'Failed'
                  : job.state === 'cancelled'
                    ? 'Cancelled'
                    : job.state === 'partial'
                      ? 'Partial results'
                      : job.state}
            </strong>{' '}
            · Job area: {job.area.center.latitude}, {job.area.center.longitude}{' '}
            · {job.area.radiusKm} km ·{' '}
            {job.counts.added + job.counts.updated + job.counts.unchanged} saved
            ({job.counts.added} added, {job.counts.updated} updated)
            <span>
              {' '}
              · Stage: {job.stage} · {job.counts.discovered} discovered ·{' '}
              {job.counts.checked} checked · {job.counts.rejected} rejected
            </span>
            <p>
              Coverage {job.coverage.status} · Last successful check:{' '}
              {job.coverage.lastSuccessfulCheckAt ?? 'Unknown'}
            </p>
            {job.coverage.caveats.map((caveat) => (
              <p key={caveat}>{caveat}</p>
            ))}
            {job.sources
              .filter((source) => source.error)
              .map((source) => (
                <p key={source.sourceId}>
                  {source.sourceId}: {source.error?.message}
                </p>
              ))}
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
