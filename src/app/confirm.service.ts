import { Injectable, signal } from '@angular/core';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly visible = signal(false);
  readonly options = signal<ConfirmOptions>({ title: '', message: '' });
  private resolve!: (value: boolean) => void;

  ask(opts: ConfirmOptions): Promise<boolean> {
    this.options.set(opts);
    this.visible.set(true);
    return new Promise((res) => { this.resolve = res; });
  }

  confirm(): void {
    this.visible.set(false);
    this.resolve(true);
  }

  cancel(): void {
    this.visible.set(false);
    this.resolve(false);
  }
}
