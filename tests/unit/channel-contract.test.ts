import { describe, expect, expectTypeOf, it } from 'vitest'
import { CHANNEL_NAMES, type ChannelAtMessage, type ChannelMessageRoute, type ChannelService } from '../../src/common/channel.js'
import { parseAtMessage, type DingtalkAtMessage, type DingtalkMessageRoute } from '../../src/dingtalk/inbox.js'
import type { DingtalkService } from '../../src/dingtalk/service.js'
import type { DingtalkAt, DingtalkTarget } from '../../src/dingtalk/args.js'

describe('channel contract', () => {
  it('lists the implemented channels', () => {
    expect(CHANNEL_NAMES).toEqual(['dingtalk', 'feishu'])
  })

  it('DingtalkService satisfies ChannelService and its message types extend the shared ones', () => {
    expectTypeOf<DingtalkService>().toMatchTypeOf<ChannelService<DingtalkTarget, DingtalkAt>>()
    expectTypeOf<DingtalkAtMessage>().toMatchTypeOf<ChannelAtMessage>()
    expectTypeOf<DingtalkMessageRoute>().toEqualTypeOf<ChannelMessageRoute<DingtalkAtMessage>>()
  })

  it('maps the DingTalk sender to the shared senderId without dropping the original field', () => {
    const line = JSON.stringify({ type: 'user_im_message_receive_at', event_id: 'e1', conversation_id: 'cidA', sender_open_dingtalk_id: 'sender-1', content: 'hi' })
    expect(parseAtMessage(line)).toMatchObject({ senderOpenDingtalkId: 'sender-1', senderId: 'sender-1' })
    const anonymous = JSON.stringify({ type: 'user_im_message_receive_at', event_id: 'e2', conversation_id: 'cidA', content: 'hi' })
    expect(parseAtMessage(anonymous)).not.toHaveProperty('senderId')
  })
})
