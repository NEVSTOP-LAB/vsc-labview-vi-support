/**
 * WebView 消息协议类型定义。
 *
 * - `InboundMessage`：从 WebView 发往扩展宿主的消息结构。
 * - `OutboundState`：从扩展宿主推送给 WebView 的完整状态快照。
 */

import type { PropsJsonEnvelope } from '../scripts/propsParser';
import type { ViewMode } from './viewMode';

export interface InboundMessage {
  type: string;
  [key: string]: unknown;
}

export interface OutboundState {
  type: 'state';
  viPath: string;
  hash: string;
  viewMode: ViewMode;
  fpImage: string | null;
  bdImage: string | null;
  props: PropsJsonEnvelope | null;
  errors: string[];
  loading: { fp: boolean; bd: boolean; props: boolean };
}
