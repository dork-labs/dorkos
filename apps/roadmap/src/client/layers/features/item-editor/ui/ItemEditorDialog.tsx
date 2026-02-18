import type { CreateItemRequest, UpdateItemRequest } from '@dorkos/shared/roadmap-schemas';
import { useAppStore } from '@/layers/shared/model';
import { useRoadmapItems, useCreateItem, useUpdateItem, useDeleteItem } from '@/layers/entities/roadmap-item';
import { ItemForm } from './ItemForm';

/**
 * Modal dialog for creating or editing a roadmap item.
 *
 * Reads `editingItemId` from the Zustand app store:
 * - `null` → renders nothing
 * - `'new'` → create mode (empty form, "New Item" title)
 * - UUID → edit mode (pre-filled form, "Edit Item" title, delete available)
 *
 * Closes itself on successful save/delete or backdrop click.
 */
export function ItemEditorDialog() {
  const editingItemId = useAppStore((s) => s.editingItemId);
  const setEditingItemId = useAppStore((s) => s.setEditingItemId);

  const { data: items } = useRoadmapItems();
  const createItem = useCreateItem();
  const updateItem = useUpdateItem();
  const deleteItem = useDeleteItem();

  if (!editingItemId) return null;

  // After the null guard above, editingItemId is a non-null string for the whole render.
  const itemId: string = editingItemId;
  const isNew = itemId === 'new';
  const existingItem = isNew ? undefined : items?.find((i) => i.id === itemId);

  const title = isNew ? 'New Item' : 'Edit Item';
  const isSubmitting =
    createItem.isPending || updateItem.isPending || deleteItem.isPending;

  function handleClose() {
    setEditingItemId(null);
  }

  function handleSubmit(data: CreateItemRequest | UpdateItemRequest) {
    if (isNew) {
      createItem.mutate(data as CreateItemRequest, { onSuccess: handleClose });
    } else {
      updateItem.mutate(
        { id: itemId, body: data as UpdateItemRequest },
        { onSuccess: handleClose }
      );
    }
  }

  function handleDelete() {
    deleteItem.mutate(itemId, { onSuccess: handleClose });
  }

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={handleClose}
      role="presentation"
    >
      {/* Dialog content */}
      <div
        className="w-full max-w-lg rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-100 px-6 py-4">
          <h2 className="text-base font-semibold text-neutral-900">{title}</h2>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={handleClose}
            className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">
          <ItemForm
            initialValues={existingItem}
            isSubmitting={isSubmitting}
            onSubmit={handleSubmit}
            onDelete={isNew ? undefined : handleDelete}
          />
        </div>
      </div>
    </div>
  );
}
