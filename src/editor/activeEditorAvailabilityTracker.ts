export interface ActiveEditorAvailabilitySnapshot {
  active: boolean;
  available: boolean;
}

export class ActiveEditorAvailabilityTracker<T extends object> {
  private activeEditor: T | null = null;
  private readonly availability = new Map<T, boolean>();

  public setActive(editor: T | null): ActiveEditorAvailabilitySnapshot {
    this.activeEditor = editor;
    return this.snapshot();
  }

  public setAvailable(editor: T, available: boolean): ActiveEditorAvailabilitySnapshot {
    this.availability.set(editor, available);
    return this.snapshot();
  }

  public delete(editor: T): ActiveEditorAvailabilitySnapshot {
    this.availability.delete(editor);
    if (this.activeEditor === editor) {
      this.activeEditor = null;
    }
    return this.snapshot();
  }

  public snapshot(): ActiveEditorAvailabilitySnapshot {
    if (this.activeEditor === null) {
      return { active: false, available: false };
    }

    return {
      active: true,
      available: this.availability.get(this.activeEditor) ?? false,
    };
  }
}