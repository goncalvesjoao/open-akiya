import { useEffect, useRef, useState } from 'react'
import type { SelectedArea } from '../../shared/listings'
import type { ImportRequest, Job } from '../../shared/desktop'

const requestStorageKey = 'open-akiya.import-request-ids'
function retainedRequestIds(): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(requestStorageKey) ?? '[]',
    )
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string')
      : []
  } catch {
    return []
  }
}
function retainRequestId(id: string) {
  try {
    localStorage.setItem(
      requestStorageKey,
      JSON.stringify([...new Set([...retainedRequestIds(), id])]),
    )
  } catch {
    /* Queue remains available when browser storage is unavailable. */
  }
}

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
  const [requestHistory, setRequestHistory] = useState<ImportRequest[]>([])
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
  const revision = useRef(0)
  useEffect(() => {
    settled.current = onSettled
  }, [onSettled])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const reconnect = new Set(retainedRequestIds())
    const stalePoll = Symbol('stale poll')
    async function refresh() {
      const startedAtRevision = revision.current
      function ensureCurrent() {
        if (!active || startedAtRevision !== revision.current) throw stalePoll
      }
      try {
        const activeJobs = (
          await window.openAkiya.listImports({ state: 'active' })
        ).jobs
        ensureCurrent()
        for (const job of activeJobs) observedJobs.current.set(job.id, job)
        for (const id of reconnect) {
          const restored = await window.openAkiya.inspectImportRequest(id)
          ensureCurrent()
          requests.current.set(id, restored)
          setRequestHistory((history) => [
            ...history.filter((item) => item.id !== id),
            restored,
          ])
          reconnect.delete(id)
        }
        for (const [id, snapshot] of requests.current) {
          const nextRequest = await window.openAkiya.inspectImportRequest(id)
          ensureCurrent()
          requests.current.set(id, nextRequest)
          setRequestHistory((history) =>
            history.map((item) => (item.id === id ? nextRequest : item)),
          )
          if (requestRef.current === id) setRequest(nextRequest)
          for (const jobId of nextRequest.jobIds) {
            const job = await window.openAkiya.inspectImport(jobId)
            ensureCurrent()
            observedJobs.current.set(job.id, job)
          }
          if (
            isTerminal(nextRequest.state) &&
            !nextRequest.pendingFollowUp &&
            nextRequest.jobIds.every((jobId) => {
              const job = observedJobs.current.get(jobId)
              return job !== undefined && isTerminal(job.state)
            })
          )
            requests.current.delete(id)
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
            const response = await window.openAkiya.inspectImport(id)
            ensureCurrent()
            observedJobs.current.set(id, response)
          }
        }
        ensureCurrent()
        const next = [
          ...activeJobs.map((job) => observedJobs.current.get(job.id) ?? job),
          ...[...observedJobs.current.values()].filter(
            (job) => !activeJobs.some((activeJob) => activeJob.id === job.id),
          ),
        ]
        const revision = JSON.stringify(
          next.map((job) => [job.id, job.state, job.finishedAt]),
        )
        if (previous.current !== revision) {
          previous.current = revision
          settled.current()
        }
        setJobs(next)
        setWorkerError('')
      } catch (failure) {
        if (active && failure !== stalePoll)
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
            retainRequestId(accepted.id)
            requests.current.set(accepted.id, accepted)
            setRequestHistory((history) => [
              ...history.filter((item) => item.id !== accepted.id),
              accepted,
            ])
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
      <ul aria-label="Your import requests" aria-live="polite">
        {requestHistory.map((item) => (
          <li key={item.id} aria-label={`Import request ${item.id}`}>
            Request {item.id} · {item.disposition} · {item.state} · Request
            area: {item.area.center.latitude}, {item.area.center.longitude} ·{' '}
            {item.area.radiusKm} km
            {item.pendingFollowUp && ' · Follow-up pending'}
            <p>
              Linked jobs: {item.jobIds.join(', ') || 'None'}. Cancelling this
              request withdraws your intent and pending follow-up. Shared work
              may continue for other requests; inspect the linked job state
              below.
            </p>
            {!isTerminal(item.state) && (
              <button
                onClick={async () => {
                  setError('')
                  try {
                    const response = await window.openAkiya.cancelImportRequest(
                      item.id,
                    )
                    revision.current++
                    requests.current.set(response.id, response)
                    setRequestHistory((history) =>
                      history.map((entry) =>
                        entry.id === response.id ? response : entry,
                      ),
                    )
                    if (requestRef.current === response.id) setRequest(response)
                    if (isTerminal(response.state)) settled.current()
                  } catch {
                    setError(
                      'Could not cancel request intent. Inspect its current state before retrying.',
                    )
                  }
                }}
              >
                Cancel request intent
              </button>
            )}
          </li>
        ))}
      </ul>
      <p>
        Closing the window keeps imports running. Reopen from the desktop
        launcher. Use Quit Open Akiya or Ctrl/Cmd+Q to exit.
      </p>
      {(error || workerError) && <p role="alert">{error || workerError}</p>}
      <ul aria-label="Import queue" aria-live="polite">
        {jobs.map((job) => (
          <li key={job.id} aria-label={`Import job ${job.id}`}>
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
            {job.cancelRequestedAt && !isTerminal(job.state) && (
              <p role="status">
                Cancellation requested · Waiting for running work to settle
              </p>
            )}
            <p>
              Cancelling this job stops its queued work or running execution for
              all attached requests. Committed listings remain saved.
            </p>
            {(job.state === 'running' || job.state === 'queued') && (
              <button
                disabled={job.cancelRequestedAt !== null}
                onClick={async () => {
                  setError('')
                  try {
                    const response = await window.openAkiya.cancelImport(job.id)
                    revision.current++
                    observedJobs.current.set(response.id, response)
                    setJobs((history) =>
                      history.map((item) =>
                        item.id === response.id ? response : item,
                      ),
                    )
                    if (isTerminal(response.state)) settled.current()
                  } catch {
                    setError(
                      'Could not cancel import. Inspect its current state before retrying.',
                    )
                  }
                }}
              >
                Cancel {job.state === 'queued' ? 'queued' : 'running'} job
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
