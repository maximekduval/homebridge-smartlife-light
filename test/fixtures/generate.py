#!/usr/bin/env python3
"""
Regenerates test/fixtures/frames.json with TinyTuya as the reference implementation.

The TypeScript codec in src/tuya/protocol.ts must produce exactly these bytes, which is how we know
it speaks the same protocol as real Tuya devices without needing a device at hand.

    python3 -m venv .venv && .venv/bin/pip install tinytuya
    .venv/bin/python -I test/fixtures/generate.py > test/fixtures/frames.json

Everything below uses a fake device id / key and fixed nonces, IVs and timestamps.
"""
import hmac
import json
import logging
import struct
import sys
import time
from hashlib import sha256

import tinytuya
from tinytuya.core import command_types as CT
from tinytuya.core import header as H
from tinytuya.core import udp_helper
from tinytuya.core.crypto_helper import AESCipher
from tinytuya.core.message_helper import MessagePayload, TuyaMessage, pack_message, unpack_message

# A fixed IV makes the 3.5 (AES-GCM) frames reproducible: TinyTuya switches to b'0123456789ab' in debug mode.
logging.getLogger('tinytuya.core.crypto_helper').setLevel(logging.DEBUG)

NOW = 1700000000
time.time = lambda: float(NOW)

DEV_ID = 'bf0123456789abcdef0123'
LOCAL_KEY = '0123456789abcdef'
SEQ = 7
LOCAL_NONCE = bytes(range(16))
REMOTE_NONCE = bytes(range(100, 116))
KEY = LOCAL_KEY.encode('latin1')

STATUS_PUSH = {'dps': {'20': True, '22': 500}, 't': NOW}
QUERY_REPLY = {'devId': DEV_ID, 'dps': {'20': False, '21': 'white', '22': 10, '23': 1000, '24': '000003e803e8'}}


def hx(b):
    return b.hex()


def device_frame(version, cmd, obj, key, seq=9, with_retcode=True):
    """Builds a frame the way a device sends it (retcode first), then proves TinyTuya can read it back."""
    data = json.dumps(obj, separators=(',', ':')).encode() if obj is not None else b''
    retcode = struct.pack('>I', 0)
    header = {3.3: H.PROTOCOL_33_HEADER, 3.4: H.PROTOCOL_34_HEADER, 3.5: H.PROTOCOL_35_HEADER}[version]
    pushes = cmd == CT.STATUS

    if version == 3.3:
        enc = AESCipher(key).encrypt(data, False) if data else b''
        payload = retcode + ((header + enc) if pushes and enc else enc)
        frame = pack_message(TuyaMessage(seq, cmd, 0, payload, 0, True, H.PREFIX_55AA_VALUE, None))
        msg = unpack_message(frame)
    elif version == 3.4:
        plain = ((header + data) if pushes and data else data)
        enc = AESCipher(key).encrypt(plain, False) if plain else b''
        frame = pack_message(TuyaMessage(seq, cmd, 0, retcode + enc, 0, True, H.PREFIX_55AA_VALUE, None), hmac_key=key)
        msg = unpack_message(frame, hmac_key=key)
    else:
        plain = ((header + data) if pushes and data else data)
        frame = pack_message(TuyaMessage(seq, cmd, 0, plain, 0, True, H.PREFIX_6699_VALUE, b'0123456789ab'), hmac_key=key)
        msg = unpack_message(frame, hmac_key=key, no_retcode=False)

    assert msg.retcode == 0, 'TinyTuya could not re-read its own device frame'
    return frame


def sharing_vectors():
    """
    Request signing / encryption of Tuya's device-sharing API (the one behind the "scan a QR code" login).

    The three helpers below are transcribed from tuya-device-sharing-sdk (MIT, tuya_sharing/customerapi.py), with the
    random nonce made an argument so the output is reproducible.
    """
    import base64
    import hashlib
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    def secret_generating(rid, sid, hash_key):
        message = hash_key
        assert sid == ''  # the SDK never uses a session id
        return hmac.new(rid.encode(), message.encode(), sha256).digest().hex()[:16]

    def restful_sign(hash_key, query_encdata, body_encdata, data):
        header_sign_str = ''
        for item in ['X-appKey', 'X-requestId', 'X-sid', 'X-time', 'X-token']:
            val = data.get(item, '')
            if val != '':
                header_sign_str += item + '=' + val + '||'
        sign_str = header_sign_str[:-2]
        if query_encdata:
            sign_str += query_encdata
        if body_encdata:
            sign_str += body_encdata
        return hmac.new(hash_key.encode(), sign_str.encode(), sha256).hexdigest()

    def encrypt(raw_data, secret, nonce):
        ciphertext = AESGCM(secret.encode()).encrypt(nonce.encode(), raw_data.encode(), None)
        return (base64.b64encode(nonce.encode()) + base64.b64encode(ciphertext)).decode()

    rid = '8f2b0b5e-9c1a-4d6e-a3f4-1b2c3d4e5f60'
    refresh_token = 'refreshtoken0123456789abcdef'
    access_token = 'accesstoken0123456789abcdef01'
    client_id = 'HA_3y9q4ak7g4ephrvke'
    now_ms = 1700000000123

    hash_key = hashlib.md5((rid + refresh_token).encode()).hexdigest()
    secret = secret_generating(rid, '', hash_key)
    query_enc = encrypt('{"homeId":"12345"}', secret, 'ABCDEFGHJKMN')
    body_enc = encrypt('{"commands":[{"code":"switch_led","value":true}]}', secret, 'nopqrstwxyz2')
    headers = {'X-appKey': client_id, 'X-requestId': rid, 'X-sid': '', 'X-time': str(now_ms), 'X-token': access_token}
    # what the server sends back: base64(nonce || ciphertext || tag)
    reply_nonce = b'abcdefhijkmn'
    reply_plain = '[{"ownerId":"12345","name":"My home"}]'
    reply = base64.b64encode(reply_nonce + AESGCM(secret.encode()).encrypt(reply_nonce, reply_plain.encode(), None)).decode()

    return {
        'rid': rid,
        'refreshToken': refresh_token,
        'accessToken': access_token,
        'clientId': client_id,
        'nowMs': now_ms,
        'hashKey': hash_key,
        'secret': secret,
        'queryEncdata': query_enc,
        'bodyEncdata': body_enc,
        'signQuery': restful_sign(hash_key, query_enc, '', headers),
        'signBody': restful_sign(hash_key, '', body_enc, headers),
        'signNoToken': restful_sign(hash_key, query_enc, '', {k: v for k, v in headers.items() if k != 'X-token'}),
        'reply': reply,
        'replyPlain': reply_plain,
    }


def main():
    out = {
        'devId': DEV_ID,
        'localKey': LOCAL_KEY,
        'now': NOW,
        'seq': SEQ,
        'localNonce': hx(LOCAL_NONCE),
        'remoteNonce': hx(REMOTE_NONCE),
        'tinytuyaVersion': tinytuya.version,
    }

    for ver in (3.3, 3.4, 3.5):
        d = tinytuya.Device(DEV_ID, '127.0.0.1', LOCAL_KEY, version=ver)
        entry = {'payloads': {}, 'frames': {}, 'incoming': {}}

        session_key = KEY
        if ver >= 3.4:
            # --- session key negotiation, with fixed nonces ---
            d._negotiate_session_key_generate_step_1()  # also resets the key to the real local key
            d.local_nonce = LOCAL_NONCE  # step 1 picked a random nonce: replace it, then build the frame from the fixed one
            step1 = MessagePayload(CT.SESS_KEY_NEG_START, LOCAL_NONCE)
            d.seqno = SEQ
            entry['neg'] = {'start': hx(d._encode_message(step1))}

            answer = REMOTE_NONCE + hmac.new(KEY, LOCAL_NONCE, sha256).digest()
            if ver == 3.4:
                rkey_payload = AESCipher(KEY).encrypt(answer, False)
                resp_frame = pack_message(
                    TuyaMessage(1, CT.SESS_KEY_NEG_RESP, 0, struct.pack('>I', 0) + rkey_payload, 0, True, H.PREFIX_55AA_VALUE, None),
                    hmac_key=KEY)
            else:
                rkey_payload = answer
                resp_frame = pack_message(
                    TuyaMessage(1, CT.SESS_KEY_NEG_RESP, 0, answer, 0, True, H.PREFIX_6699_VALUE, b'0123456789ab'),
                    hmac_key=KEY)
            rkey = TuyaMessage(1, CT.SESS_KEY_NEG_RESP, 0, rkey_payload, 0, True, H.PREFIX_55AA_VALUE, None)
            step3 = d._negotiate_session_key_generate_step_3(rkey)
            assert step3, 'TinyTuya rejected the fabricated negotiation answer'
            d.seqno = SEQ + 1
            entry['neg']['response'] = hx(resp_frame)
            entry['neg']['finishPayload'] = hx(step3.payload)
            entry['neg']['finish'] = hx(d._encode_message(step3))
            d._negotiate_session_key_generate_finalize()
            session_key = d.local_key
            entry['neg']['sessionKey'] = hx(session_key)

        # --- outgoing commands, with the session key when there is one ---
        builders = {
            'query': d.generate_payload(CT.DP_QUERY),
            'control': d.generate_payload(CT.CONTROL, {'20': True, '22': 500}),
            'heartbeat': d.generate_payload(CT.HEART_BEAT),
        }
        for name, mp in builders.items():
            entry['payloads'][name] = {'cmd': mp.cmd, 'payload': hx(mp.payload)}
            d.seqno = SEQ + 2
            entry['frames'][name] = hx(d._encode_message(mp))

        # --- frames a device would send back ---
        entry['incoming']['statusPush'] = {
            'frame': hx(device_frame(ver, CT.STATUS, STATUS_PUSH, session_key)), 'json': STATUS_PUSH, 'cmd': CT.STATUS}
        query_cmd = CT.DP_QUERY if ver == 3.3 else CT.DP_QUERY_NEW
        entry['incoming']['queryReply'] = {
            'frame': hx(device_frame(ver, query_cmd, QUERY_REPLY, session_key)), 'json': QUERY_REPLY, 'cmd': query_cmd}
        control_cmd = CT.CONTROL if ver == 3.3 else CT.CONTROL_NEW
        entry['incoming']['controlAck'] = {
            'frame': hx(device_frame(ver, control_cmd, None, session_key)), 'json': None, 'cmd': control_cmd}

        out['v' + str(ver)] = entry

    # --- UDP discovery: broadcasts a device sends, and the request an app sends to wake v3.5 devices up ---
    udpkey = udp_helper.udpkey
    announce = {'ip': '192.168.1.50', 'gwId': DEV_ID, 'active': 2, 'ablilty': 0, 'encrypt': True,
                'productKey': 'keyfakeproduct1234', 'version': '3.3', 'token': True, 'wf_cfg': True}
    announce_bytes = json.dumps(announce, separators=(',', ':')).encode()
    retcode = struct.pack('>I', 0)
    request = json.dumps({'from': 'app', 'ip': '192.168.1.10'}).encode()  # TinyTuya keeps json.dumps' default spacing
    out['udp'] = {
        'key': hx(udpkey),
        'announce': announce,
        'plain6666': hx(pack_message(TuyaMessage(0, 0, 0, retcode + announce_bytes, 0, True, H.PREFIX_55AA_VALUE, None))),
        'encrypted6667': hx(pack_message(TuyaMessage(
            0, CT.UDP_NEW, 0, retcode + udp_helper.encrypt(announce_bytes, udpkey), 0, True, H.PREFIX_55AA_VALUE, None))),
        'app7000': hx(pack_message(TuyaMessage(
            0, CT.REQ_DEVINFO, 0, announce_bytes, 0, True, H.PREFIX_6699_VALUE, b'0123456789ab'), hmac_key=udpkey)),
        'request': hx(pack_message(TuyaMessage(
            0, CT.REQ_DEVINFO, None, request, 0, True, H.PREFIX_6699_VALUE, b'0123456789ab'), hmac_key=udpkey)),
        'requestIp': '192.168.1.10',
    }
    for name in ('plain6666', 'encrypted6667', 'app7000'):
        decoded = json.loads(udp_helper.decrypt_udp(bytes.fromhex(out['udp'][name])))
        assert decoded == announce, 'TinyTuya cannot read its own %s fixture' % name

    out['sharing'] = sharing_vectors()

    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
