import {
  CONTACT_BULK_ADD_QUEUE,
  createQueue,
  createWorker,
  createWorkerHandler,
  type TeamJob,
} from "../queue";
import { logger } from "../logger/log";
import { addOrUpdateContact, ContactInput } from "./contact-service";

type ContactJobData = {
  contactBookId: string;
  contact: ContactInput;
  teamId?: number;
};

type ContactJob = TeamJob<ContactJobData>;

class ContactQueueService {
  public static queue = createQueue<ContactJobData>(CONTACT_BULK_ADD_QUEUE);

  public static worker = createWorker(
    CONTACT_BULK_ADD_QUEUE,
    createWorkerHandler(processContactJob),
    {
      concurrency: 20,
      onError: (err) => {
        logger.error({ err }, "[ContactQueueService]: Worker error");
      },
    },
  );

  static {
    logger.info("[ContactQueueService]: Initialized contact queue service");
  }

  public static async addContactJob(
    contactBookId: string,
    contact: ContactInput,
    teamId?: number,
    delay?: number,
  ) {
    await this.queue.enqueue(
      `add-contact-${contact.email}`,
      {
        contactBookId,
        contact,
        teamId,
      },
      { delay },
    );
  }

  public static async addBulkContactJobs(
    contactBookId: string,
    contacts: ContactInput[],
    teamId?: number,
  ) {
    const jobs = contacts.map((contact) => ({
      name: `add-contact-${contact.email}`,
      data: {
        contactBookId,
        contact,
        teamId,
      },
    }));

    await this.queue.enqueueBulk(jobs);
    logger.info(
      { count: contacts.length, contactBookId },
      "[ContactQueueService]: Added bulk contact jobs to queue",
    );
  }

  public static async getQueueStats() {
    return await this.queue.getStats();
  }
}

async function processContactJob(job: ContactJob) {
  const { contactBookId, contact, teamId } = job.data;

  logger.info(
    { contactEmail: contact.email, contactBookId },
    "[ContactQueueService]: Processing contact job",
  );

  try {
    await addOrUpdateContact(contactBookId, contact, teamId);
    logger.info(
      { contactEmail: contact.email },
      "[ContactQueueService]: Successfully processed contact job",
    );
  } catch (error) {
    logger.error(
      { contactEmail: contact.email, error },
      "[ContactQueueService]: Failed to process contact job",
    );
    throw error;
  }
}

export { ContactQueueService };
