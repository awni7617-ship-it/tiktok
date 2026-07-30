import { PrismaClient, Role } from '@prisma/client';
import { newId } from '../src/lib/id';
import { hashPassword } from '../src/server/security/crypto';

/**
 * Development seed.
 *
 * Creates one workspace with an owner and an editor, a brand kit and a couple
 * of templates — enough to exercise permissions and the collaboration surfaces
 * without hand-clicking through signup. Idempotent, so re-running it after a
 * schema change is safe.
 */

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const passwordHash = await hashPassword('phantom-dev-password');

  const owner = await prisma.user.upsert({
    where: { email: 'owner@phantom.local' },
    update: {},
    create: {
      id: newId('usr'),
      email: 'owner@phantom.local',
      name: 'Demo Owner',
      emailVerified: true,
      passwordHash,
    },
  });

  const editor = await prisma.user.upsert({
    where: { email: 'editor@phantom.local' },
    update: {},
    create: {
      id: newId('usr'),
      email: 'editor@phantom.local',
      name: 'Demo Editor',
      emailVerified: true,
      passwordHash,
    },
  });

  const workspace = await prisma.workspace.upsert({
    where: { slug: 'demo' },
    update: {},
    create: {
      id: newId('wsp'),
      name: 'Demo workspace',
      slug: 'demo',
    },
  });

  for (const [user, role] of [
    [owner, Role.OWNER],
    [editor, Role.EDITOR],
  ] as const) {
    await prisma.membership.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
      update: { role },
      create: { id: newId('mem'), userId: user.id, workspaceId: workspace.id, role },
    });
  }

  const existingBrandKit = await prisma.brandKit.findFirst({
    where: { workspaceId: workspace.id, isDefault: true },
  });

  if (!existingBrandKit) {
    await prisma.brandKit.create({
      data: {
        id: newId('brk'),
        workspaceId: workspace.id,
        name: 'Default',
        primaryColor: '#7C5CFF',
        accentColor: '#00E0B8',
        fontFamily: 'Inter',
        isDefault: true,
        captionStyle: {
          animation: 'karaoke',
          fontSizePx: 64,
          highlightColor: '#7C5CFF',
          outlineWidth: 4,
          positionY: 0.72,
        },
      },
    });
  }

  const templates = [
    {
      name: 'Talking head — tight',
      description: 'Aggressive silence removal, karaoke captions, vertical reframe.',
      config: {
        removeSilence: true,
        removeFillers: true,
        improvePacing: true,
        silence: { minSilenceSec: 0.25, paddingSec: 0.05 },
        captionStyle: { animation: 'karaoke', uppercase: false },
      },
    },
    {
      name: 'Faceless story',
      description: 'Narration, B-roll, moody music bed, large captions.',
      config: {
        addMusic: true,
        music: { moods: ['tense', 'story'] },
        captionStyle: { animation: 'pop', fontSizePx: 72, uppercase: true },
      },
    },
  ];

  for (const template of templates) {
    const exists = await prisma.template.findFirst({
      where: { workspaceId: workspace.id, name: template.name },
    });
    if (exists) continue;

    await prisma.template.create({
      data: {
        id: newId('tpl'),
        workspaceId: workspace.id,
        name: template.name,
        description: template.description,
        config: template.config,
        createdById: owner.id,
      },
    });
  }

  console.log(`Seeded workspace "${workspace.name}"`);
  console.log('  owner@phantom.local  / phantom-dev-password');
  console.log('  editor@phantom.local / phantom-dev-password');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
