import { useEffect, useRef, useState } from 'react'
import type { SelectedArea } from '../../shared/listings'
import type { ImportRequest, Job } from '../../shared/desktop'
import { recoveryIds, saveRecovery } from './recovery-storage'

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
  const [initialRequestIds] = useState(() => recoveryIds('import-request-ids'))
  const retainedRequests = useRef(new Set(initialRequestIds))
  const retainedJobs = useRef(new Set(recoveryIds('import-job-ids')))
  const requests = useRef(
    new Map<string, ImportRequest | null>(
      initialRequestIds.map((id) => [id, null]),
    ),
  )
  const observedJobs = useRef(new Map<string, Job>())
  const [jobs, setJobs] = useState<Job[]>([])
  const [error, setError] = useState('')
  const [workerError, setWorkerError] = useState('')
  const pendingAction = useRef<{ scope: string; key: string } | null>(null)
  const [creating, setCreating] = useState(false)
  const settled = useRef(onSettled)
  const requestRef = useRef<string | null>(initialRequestIds.at(-1) ?? null)
  const retryRecovery = useRef<() => void>(() => {})
  const previous = useRef('')
  useEffect(() => {
    settled.current = onSettled
  }, [onSettled])
  useEffect(() => {
    let active = true
    let refreshing = false
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      if (refreshing) return
      refreshing = true
      let inspectionFailed = false
      async function inspect<T>(
        operation: () => Promise<T>,
      ): Promise<T | undefined> {
        try {
          return await operation()
        } catch {
          inspectionFailed = true
          return undefined
        }
      }
      try {
        const activeJobs =
          (
            await inspect(() =>
              window.openAkiya.listImports({ state: 'active' }),
            )
          )?.jobs ?? []
        if (!active) return
        for (const job of activeJobs) {
          observedJobs.current.set(job.id, job)
          retainedJobs.current.add(job.id)
        }
        saveRecovery('import-job-ids', [...retainedJobs.current])
        for (const [id, snapshot] of requests.current) {
          const nextRequest = await inspect(() =>
            window.openAkiya.inspectImportRequest(id),
          )
          if (!nextRequest) continue
          if (!active) return
          requests.current.set(id, nextRequest)
          if (requestRef.current === id) setRequest(nextRequest)
          for (const jobId of nextRequest.jobIds) {
            retainedJobs.current.add(jobId)
            saveRecovery('import-job-ids', [...retainedJobs.current])
            const job = await inspect(() =>
              window.openAkiya.inspectImport(jobId),
            )
            if (!job) continue
            if (!active) return
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
            snapshot?.state !== nextRequest.state &&
            isTerminal(nextRequest.state)
          )
            settled.current()
        }
        // Active jobs disappear from the queue at completion; inspect retained IDs.
        for (const id of retainedJobs.current) {
          const snapshot = observedJobs.current.get(id)
          if (
            (!snapshot || !isTerminal(snapshot.state)) &&
            !activeJobs.some((job) => job.id === id)
          ) {
            const job = await inspect(() => window.openAkiya.inspectImport(id))
            if (job) observedJobs.current.set(id, job)
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
        setWorkerError(
          inspectionFailed
            ? 'Reconnecting to import worker. Saved listings and successful-check times are retained. This is not an import failure.'
            : '',
        )
      } catch {
        if (active)
          setWorkerError(
            'Reconnecting to import worker. Saved listings and successful-check times are retained. This is not an import failure.',
          )
      }
      refreshing = false
      if (active) timer = setTimeout(refresh, 500)
    }
    retryRecovery.current = () => {
      clearTimeout(timer)
      void refresh()
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
            retainedRequests.current.add(accepted.id)
            saveRecovery('import-request-ids', [...retainedRequests.current])
            for (const id of accepted.jobIds) retainedJobs.current.add(id)
            saveRecovery('import-job-ids', [...retainedJobs.current])
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
      {workerError && (
        <button onClick={() => retryRecovery.current()}>
          Reconnect imports
        </button>
      )}
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
