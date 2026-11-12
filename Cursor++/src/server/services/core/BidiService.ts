/**
 * aiserver.v1.BidiService — Bidi 辅助服务
 *
 * 1 方法:
 *   - BidiAppend (unary) — 向 bidi 流追加消息
 *     SSE 降级模式下，客户端通过此方法发送 AgentClientMessage，
 *     requestId 关联到 RunSSE 流。消息体有两种等价编码，由客户端特性
 *     开关 bidi_append_binary_encoding_disabled 决定:
 *       - data (field 1)        — protobuf binary 的 hex 字符串 (旧版)
 *       - data_binary (field 4) — 原始 protobuf binary (Cursor 3.29+ 默认)
 *     两者承载同一份 AgentClientMessage 字节，服务端必须都接受 —— 开关由
 *     Statsig 下发且随时可能翻转，只认其中一种会让消息被静默丢弃。
 *
 * Transport: backendUrl (api2.cursor.sh)
 */
import type { ConnectRouter } from '@connectrpc/connect';
import type { BidiAppendRequest } from '../../gen/aiserver_v1_pb';
import { BidiService } from '../../gen/aiserver_v1_pb';
import { appendMessage } from '../../handlers/agent/session';
import { logger } from '../../logger';

/** BidiAppend 载荷来源，仅用于日志与测试断言 */
export type BidiAppendPayloadSource = 'data_binary' | 'data_hex' | 'none';

export interface BidiAppendPayload {
    bytes?: Uint8Array;
    source: BidiAppendPayloadSource;
}

/**
 * 从 BidiAppendRequest 提取 AgentClientMessage 字节。
 *
 * 优先 data_binary: Cursor 3.29+ 默认走这里，原始字节直接交给 fromBinary，
 * 没有 hex 编解码往返。protobuf-es 会把未设置的 bytes 字段初始化为
 * Uint8Array(0)，它是 truthy 的 —— 必须用 length 判断，不能写
 * `if (req.dataBinary)`，否则"两个字段都没填"会被误判成有载荷。
 *
 * 两个字段同时非空时以 data_binary 为准并告警: 正常客户端只会发其中一个
 * (agent-host 里是三元表达式)，出现两个说明中间层做了镜像，此时原始字节
 * 是无损的。
 */
export function resolveAppendPayload(
    req: Pick<BidiAppendRequest, 'data' | 'dataBinary'>,
): BidiAppendPayload {
    const binary = req.dataBinary?.length ? req.dataBinary : undefined;
    const hex = req.data ?? '';

    if (binary) {
        if (hex)
            logger.warn({ dataLen: hex.length, dataBinaryLen: binary.length }, '[SVC] BidiAppend has both fields, using data_binary');
        return { bytes: binary, source: 'data_binary' };
    }

    if (hex) {
        // Buffer.from(hex, 'hex') 对非法/奇数长度输入不抛错，会静默截断成
        // 更短的错误字节并可能解析出"合法但错误"的 protobuf，必须显式校验。
        if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
            logger.warn({ dataLen: hex.length }, '[SVC] BidiAppend data is not valid hex');
            return { source: 'none' };
        }
        return { bytes: Buffer.from(hex, 'hex'), source: 'data_hex' };
    }

    return { source: 'none' };
}

export default (router: ConnectRouter) => {
    router.service(BidiService, {
        bidiAppend: async (req) => {
            const requestId = req.requestId?.requestId;
            const payload = resolveAppendPayload(req);
            if (!requestId || !payload.bytes) {
                logger.warn({
                    hasRequestId: !!requestId,
                    dataLen: req.data?.length ?? 0,
                    dataBinaryLen: req.dataBinary?.length ?? 0,
                }, '[SVC] BidiAppend missing fields');
                return {};
            }
            logger.info({
                requestId,
                source: payload.source,
                bytes: payload.bytes.length,
                seqno: Number(req.appendSeqno),
            }, '[SVC] BidiAppend');
            appendMessage(requestId, payload.bytes, Number(req.appendSeqno));
            return {};
        },
    });
};
