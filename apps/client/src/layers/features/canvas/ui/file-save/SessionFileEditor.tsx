/** The existing channel hook remains the only document replay owner for this editor. */
import { useDocChannel } from '../../model/use-doc-channel';
import { FileEditor, type FileEditorProps } from './FileEditor';
/** Bind the file editor to its one existing document-channel observation. */
export function SessionFileEditor(props: FileEditorProps) {
  const { fileSaveBinding, fileSaveObservation } = useDocChannel(props.documentId);
  return (
    <FileEditor
      {...props}
      observedBinding={fileSaveBinding}
      recoveryBinding={fileSaveBinding}
      fileSaveObservation={fileSaveObservation}
    />
  );
}
