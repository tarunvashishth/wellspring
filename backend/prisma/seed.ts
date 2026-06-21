import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database…');

  const password = await bcrypt.hash('Password123!', 12);

  const [alice, bob] = await Promise.all([
    prisma.creator.upsert({
      where: { email: 'alice@example.com' },
      update: {},
      create: { email: 'alice@example.com', passwordHash: password, displayName: 'Alice Chen' },
    }),
    prisma.creator.upsert({
      where: { email: 'bob@example.com' },
      update: {},
      create: { email: 'bob@example.com', passwordHash: password, displayName: 'Bob Park' },
    }),
  ]);

  console.log(`Created creators: ${alice.email}, ${bob.email}`);

  for (const creator of [alice, bob]) {
    const programs = await Promise.all([
      prisma.program.create({
        data: {
          creatorId: creator.id,
          title: `${creator.displayName}'s Morning Flow`,
          description: 'Start your day with intention.',
          tags: ['morning', 'mindfulness'],
        },
      }),
      prisma.program.create({
        data: {
          creatorId: creator.id,
          title: `${creator.displayName}'s Strength Series`,
          description: 'Build functional strength over 8 weeks.',
          tags: ['strength', 'fitness'],
        },
      }),
      prisma.program.create({
        data: {
          creatorId: creator.id,
          title: `${creator.displayName}'s Recovery Reset`,
          description: 'Gentle movement for active recovery.',
          tags: ['recovery', 'yoga'],
        },
      }),
    ]);

    console.log(`  Created ${programs.length} programs for ${creator.displayName}`);

    for (const program of programs) {
      const sessionTitles = ['Warm Up', 'Foundation', 'Build', 'Flow', 'Power', 'Core', 'Stretch', 'Balance', 'Restore', 'Cool Down'];
      const sessionTagsList = [['warmup'],['beginner'],['intermediate'],['flow'],['strength'],['core'],['flexibility'],['balance'],['recovery'],['cooldown']];
      const sessionData = Array.from({ length: 10 }, (_, i) => ({
        programId: program.id,
        creatorId: creator.id,
        title: `Session ${i + 1}: ${sessionTitles[i]}`,
        description: `Week ${Math.floor(i / 2) + 1} session ${(i % 2) + 1}`,
        instructorName: creator.displayName,
        tags: sessionTagsList[i],
        durationSeconds: 600 + i * 120,
        position: i + 1,
        importKey: `seed-${program.id}-${i}`,
      }));

      for (const s of sessionData) {
        await prisma.session.upsert({
          where: { programId_importKey: { programId: s.programId, importKey: s.importKey! } },
          update: {},
          create: s,
        });
      }
    }

    console.log(`  Created 10 sessions per program for ${creator.displayName}`);
  }

  console.log('Seed complete!');
  console.log('');
  console.log('Test accounts:');
  console.log('  alice@example.com / Password123!');
  console.log('  bob@example.com   / Password123!');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
