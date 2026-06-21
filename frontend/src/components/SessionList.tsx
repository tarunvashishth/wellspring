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

function SessionCard({ session, isDragging = false, onDelete, onEdit, onUpload }: {
  session: Session;
  isDragging?: boolean;
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
      <span className="text-gray-300 text-lg select-none cursor-grab">⠿</span>
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
      {...listeners}
    >
      <SessionCard session={session} onDelete={onDelete} onEdit={onEdit} onUpload={onUpload} />
    </div>
  );
}

export default function SessionList({ sessions: initialSessions, onReorder, onDelete, onEdit, onUpload }: Props) {
  const [sessions, setSessions] = useState(initialSessions);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const prevRef = useRef<Session[]>(initialSessions);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const activeSession = sessions.find((s) => s.id === activeId);

  function handleDragStart(e: DragStartEvent) {
    setActiveId(e.active.id as string);
    prevRef.current = sessions;
  }

  async function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;

    const oldIdx = sessions.findIndex((s) => s.id === active.id);
    const newIdx = sessions.findIndex((s) => s.id === over.id);
    const reordered = arrayMove(sessions, oldIdx, newIdx);

    setSessions(reordered);
    setSaving(true);
    try {
      await onReorder(reordered.map((s) => s.id));
    } catch {
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
