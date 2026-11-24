import tempfile, unittest, os
import arena
class ArenaTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); arena.DB=os.path.join(self.tmp.name,'test.db'); arena.init()
    def tearDown(self): self.tmp.cleanup()
    def test_match(self):
        m=arena.create(1,10,'🎲','wins',3)
        self.assertIn('권한',arena.action(1,10,m,'join'))
        self.assertIn('신청 완료',arena.action(1,20,m,'join'))
        self.assertIn('권한',arena.action(1,20,m,'accept'))
        self.assertIn('경기 시작',arena.action(1,10,m,'accept'))
        self.assertIsNone(arena.roll(1,20,1,'🎲',6))
        self.assertIsNone(arena.roll(1,10,2,'🏀',5))
        arena.roll(1,10,3,'🎲',6); arena.roll(1,20,4,'🎲',1)
        self.assertIsNone(arena.roll(1,10,3,'🎲',6))
        arena.roll(1,10,5,'🎲',5)
        self.assertIn('개설자 승리',arena.roll(1,20,6,'🎲',2))
        self.assertIsNone(arena.roll(1,10,7,'🎲',6))
    def test_tie(self):
        m=arena.create(1,10,'🏀','total',1); arena.action(1,20,m,'join'); arena.action(1,10,m,'accept'); arena.roll(1,10,1,'🏀',3)
        self.assertIn('무승부',arena.roll(1,20,2,'🏀',3))
if __name__=='__main__': unittest.main()
