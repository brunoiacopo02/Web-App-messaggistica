import { redirect } from 'next/navigation';

// La home porta alla console. Gli account confinati (bot, campagne, chat) non possono
// aprire /console: il proxy li rimanda alla loro area con landingPath.
export default function Home() {
  redirect('/console');
}
