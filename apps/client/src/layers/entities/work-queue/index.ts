/**
 * An agent's work queue, as the app reads and writes it (DOR-3462).
 *
 * @module entities/work-queue
 */
export {
  useWorkQueue,
  useAddWorkItem,
  useRemoveWorkItem,
  useReorderWorkQueue,
  useRequeueWorkItem,
  useSetWorkQueuesStopped,
  useUpdateWorkQueue,
} from './model/use-work-queue';
