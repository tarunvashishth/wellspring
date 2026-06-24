'use client';
import { useRef, useState } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Session } from '@/lib/api';

interface Props {
  sessions: Session[];
  onReorder: (orderedIds: string[]) => Promise<void>;
  onDelete: (id: string) => void;
  onEdit: (session: Session) => void;
  onUpload: (sessionId: string) => void;
}

function MediaBadge({ status }: { status: Session['mediaStatus'] }) {
  const styles: Record<Session['mediaStatus'], string> = {
    PENDING: 'bg-gray-100 text-gray-500',
    PROCESSING: 'bg-yellow-100 text-yellow-700',
    VERIFIED: 'bg-green-100 text-green-700',
    FAILED: 'bg-red-100 text-red-600',
  };
  const labels: Record<Session['mediaStatus'], string> = {
    PENDING: 'No media',
    PROCESSING: 'Processing',
    VERIFIED: 'Verified',
    FAILED: 'Failed',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

function SessionCard({ session, isDragging = false, dragListeners, onDelete, onEdit, onUpload }: {
  session: Session;
  isDragging?: boolean;
  dragListeners?: Record<string, unknown>;
  onDelete: (id: string) => void;
  onEdit: (s: Session) => void;
  onUpload: (id: string) => void;
}) {
  const ext = session as Session & { instructorName?: string; tags?: string[] };
  return (
    <div
      className={`bg-white rounded-xl border p-4 flex items-center gap-3 shadow-sm ${
        isDragging ? 'shadow-lg opacity-80' : ''
      }`}
    >
      <span className="text-gray-300 text-lg select-none cursor-grab" {...(dragListeners ?? {})}>⠿</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{session.title}</p>
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-xs text-gray-400">{Math.floor(session.durationSeconds / 60)}m</p>
          {ext.instructorName && (
            <p className="text-xs text-gray-400">· {ext.instructorName}</p>
          )}
          {ext.tags && ext.tags.length > 0 && (
            <div className="flex gap-1">
              {ext.tags.map((t) => (
                <span key={t} className="text-xs bg-teal-50 text-teal-700 px-1.5 py-0.5 rounded-full">{t}</span>
              ))}
            </div>
          )}
        </div>
      </div>
      <MediaBadge status={session.mediaStatus} />
      {(session.mediaStatus === 'PENDING' || session.mediaStatus === 'FAILED') && (
        <button
          onClick={() => onUpload(session.id)}
          className="text-xs text-teal-600 hover:text-teal-700 font-medium"
        >
          Upload
        </button>
      )}
      <button
        onClick={() => onEdit(session)}
        className="text-xs text-gray-400 hover:text-gray-700"
      >
        Edit
      </button>
      <button
        onClick={() => onDelete(session.id)}
        className="text-xs text-red-400 hover:text-red-600"
      >
        Delete
      </button>
    </div>
  );
}

function SortableSession({ session, onDelete, onEdit, onUpload }: {
  session: Session;
  onDelete: (id: string) => void;
  onEdit: (s: Session) => void;
  onUpload: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'opacity-40' : ''}
      {...attributes}
    >
      <SessionCard session={session} dragListeners={listeners as Record<string, unknown>} onDelete={onDelete} onEdit={onEdit} onUpload={onUpload} />
    </div>
  );
}

// SessionList implements drag-and-drop reordering using @dnd-kit.
// Key concepts:
//  - Optimistic UI: the list reorders instantly on drop, then syncs with the server.
//    If the server call fails, it rolls back to the previous order.
//  - DndContext: the root provider that tracks drag state for all sortable items inside it.
//  - SortableContext: knows the ordered list of IDs and manages each item's position.
//  - DragOverlay: renders a floating "ghost" card that follows the cursor while dragging.
//    The actual card in the list becomes semi-transparent (opacity-40) as a placeholder.
export default function SessionList({ sessions: initialSessions, onReorder, onDelete, onEdit, onUpload }: Props) {
  const [sessions, setSessions] = useState(initialSessions); // local copy for optimistic updates
  const [activeId, setActiveId] = useState<string | null>(null); // ID of the card being dragged
  const [saving, setSaving] = useState(false); // disables interactions while the API call is in flight
  // prevRef stores the order BEFORE the drag in case we need to roll back.
  // useRef instead of useState because we don't want a re-render when setting it.
  const prevRef = useRef<Session[]>(initialSessions);

  // PointerSensor with distance:5 means the drag doesn't start until the pointer moves 5px.
  // This prevents accidental drags when the user just clicks (e.g. to hit Edit or Delete).
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const activeSession = sessions.find((s) => s.id === activeId);

  function handleDragStart(e: DragStartEvent) {
    setActiveId(e.active.id as string); // track which item is being dragged (for DragOverlay)
    prevRef.current = sessions; // snapshot the current order for potential rollback
  }

  async function handleDragEnd(e: DragEndEvent) {
    setActiveId(null); // hide the DragOverlay
    const { active, over } = e;
    if (!over || active.id === over.id) return; // dropped outside list or no movement — do nothing

    const oldIdx = sessions.findIndex((s) => s.id === active.id);
    const newIdx = sessions.findIndex((s) => s.id === over.id);
    // arrayMove is a @dnd-kit utility that moves an element from oldIdx to newIdx in an array.
    const reordered = arrayMove(sessions, oldIdx, newIdx);

    // Optimistic update: show the new order immediately without waiting for the server.
    setSessions(reordered);
    setSaving(true);
    try {
      // Send the new order to the backend. Backend assigns positions 1, 2, 3... accordingly.
      await onReorder(reordered.map((s) => s.id));
    } catch {
      // Server rejected the reorder — roll back to the snapshot taken at drag start.
      setSessions(prevRef.current);
    } finally {
      setSaving(false);
    }
  }

  if (sessions.length === 0) {
    return (
      <p className="text-gray-400 text-sm text-center py-12">
        No sessions yet. Create your first one.
      </p>
    );
  }

  return (
    <div className={saving ? 'pointer-events-none' : ''}>
      {saving && <p className="text-xs text-gray-400 mb-2">Saving order…</p>}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={sessions.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {sessions.map((s) => (
              <SortableSession key={s.id} session={s} onDelete={onDelete} onEdit={onEdit} onUpload={onUpload} />
            ))}
          </div>
        </SortableContext>
        <DragOverlay>
          {activeSession ? (
            <SessionCard
              session={activeSession}
              isDragging
              onDelete={() => {}}
              onEdit={() => {}}
              onUpload={() => {}}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
